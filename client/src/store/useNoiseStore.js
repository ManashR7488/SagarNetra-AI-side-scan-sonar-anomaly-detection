import { create } from 'zustand';
import { detectionsApi, noiseApi, scansApi } from '../api';
import { errorMessage } from '../config/axios';
import { SAMPLE_SCANS } from '../data/sonarData';
import { liveStatus } from '../utils/noise';
import { useMissionStore } from './useMissionStore';
import { toast } from './useToastStore';
import { useWorkspaceStore } from './useWorkspaceStore';

const DEFAULT_SAMPLE = SAMPLE_SCANS.find((s) => s.dataset === 'ai4shipwrecks') ?? SAMPLE_SCANS[0];
const ALL_DISTURBANCES = ['speckle', 'dropouts', 'resolution', 'gain'];

async function sourceFile(source) {
  if (source.kind === 'file') return source.file;
  const blob = await fetch(source.sample.image).then((r) => r.blob());
  return new File([blob], source.sample.filename, { type: blob.type || 'image/png' });
}

const sourceName = (source) => (source.kind === 'file' ? source.file.name : source.sample.name);

const freshState = () => ({
  results: { ai: null, analyst: null },
  edited: { ai: null, analyst: null },
  selectedStep: null,
  fullRes: {},
  draft: null,
  threshold: 50,
  selectedDetId: null,
  stress: {},
  stressRun: null,
});

/**
 * Noise Filtration tab (the PS's "Confidence Scoring & Noise Filtering Module"):
 *   stage 1  clean the signal step by step, noise report (stateless previews)
 *   stage 2  detect on the AI-cleaned scan (a draft scan), review false alarms, send to AI Detection
 *   stage 3  stress test: disturbances at increasing levels, detection raw / auto / fully cleaned
 */
export const useNoiseStore = create((set, get) => ({
  source: { kind: 'sample', sample: DEFAULT_SAMPLE },
  swathWidthM: '',
  stage: 1,
  profile: 'analyst',
  loading: false,
  detecting: false,
  publishing: false,
  stressOpts: { disturbances: ALL_DISTURBANCES, levels: 4, region: 'auto' },
  ...freshState(),

  // ---------------------------------------------------------------- source
  _reset: () => {
    const { fullRes, draft, source } = get();
    Object.values(fullRes).forEach((u) => URL.revokeObjectURL(u));
    // an unpublished draft of the previous file is no longer needed (it would expire after 24 h anyway)
    if (draft?.draft) scansApi.remove(draft.id).catch(() => {});
    if (source.kind === 'file' && source.url) URL.revokeObjectURL(source.url);
    set(freshState());
  },

  setSample: (id) => {
    const sample = SAMPLE_SCANS.find((s) => s.id === id);
    if (!sample) return;
    get()._reset();
    set({ source: { kind: 'sample', sample }, stage: 1 });
    get().runClean();
  },

  setFile: (file) => {
    get()._reset();
    set({ source: { kind: 'file', file, url: /\.xtf$/i.test(file.name) ? null : URL.createObjectURL(file) }, stage: 1 });
    get().runClean();
  },

  setSwath: (v) => set({ swathWidthM: v }),
  setStage: (stage) => set({ stage }),

  // ---------------------------------------------------------------- stage 1
  setProfile: (profile) => {
    set({ profile, selectedStep: get().results[profile]?.final_step ?? null });
    if (!get().results[profile]) get().runClean();
  },

  /** Run stage 1 for the current profile: Auto, or the edited settings when there are any. */
  runClean: async ({ auto } = {}) => {
    const { source, profile, edited, swathWidthM } = get();
    const useAuto = auto ?? !edited[profile];
    set({ loading: true });
    try {
      const file = await sourceFile(source);
      const result = await noiseApi.clean({
        file,
        profile,
        auto: useAuto,
        params: useAuto ? undefined : edited[profile],
        swathWidthM: swathWidthM || undefined,
      });
      if (get().source !== source) return null;      // the user picked another file meanwhile
      set((s) => ({
        results: { ...s.results, [profile]: result },
        edited: { ...s.edited, [profile]: useAuto ? null : s.edited[profile] },
        selectedStep: result.final_step,
        loading: false,
      }));
      return result;
    } catch (err) {
      set({ loading: false });
      toast.error(errorMessage(err));
      return null;
    }
  },

  autoClean: () => {
    const { profile } = get();
    set((s) => ({ edited: { ...s.edited, [profile]: null } }));
    return get().runClean({ auto: true });
  },

  /** Change one setting of the current profile (starts from what Auto chose). */
  editParam: (key, value) => {
    const { profile, results, edited } = get();
    const base = edited[profile] ?? results[profile]?.params ?? {};
    set((s) => ({ edited: { ...s.edited, [profile]: { ...base, [key]: value } } }));
  },

  discardEdits: () => set((s) => ({ edited: { ...s.edited, [s.profile]: null } })),

  selectStep: (id) => set({ selectedStep: id }),

  /** Full-resolution image of one step (same settings as the shown result). */
  loadFullRes: async (step) => {
    const { source, profile, results, swathWidthM, fullRes } = get();
    const key = `${profile}:${step}`;
    if (fullRes[key] || !results[profile]) return fullRes[key];
    try {
      const blob = await noiseApi.clean({
        file: await sourceFile(source), profile, auto: false, params: results[profile].params,
        swathWidthM: swathWidthM || undefined,
      }, { output: 'jpeg', step });
      const url = URL.createObjectURL(blob);
      set((s) => ({ fullRes: { ...s.fullRes, [key]: url } }));
      return url;
    } catch (err) {
      toast.error(errorMessage(err));
      return null;
    }
  },

  // ---------------------------------------------------------------- stage 2
  /** Settings the detector input uses: the AI profile from stage 1 (edited ones if the user changed them). */
  aiParams: async () => {
    const { edited, results } = get();
    if (edited.ai) return edited.ai;
    if (results.ai) return results.ai.params;
    const prev = get().profile;
    set({ profile: 'ai' });
    const r = await get().runClean({ auto: true });
    set({ profile: prev, selectedStep: get().results[prev]?.final_step ?? get().selectedStep });
    return r?.params ?? null;
  },

  /** Detect on the AI-cleaned scan: a draft scan (created once, re-analysed when the settings change). */
  runDetection: async () => {
    const { source, draft, swathWidthM } = get();
    set({ detecting: true });
    try {
      const cleaning = await get().aiParams();
      if (!cleaning) throw new Error('Could not prepare the AI cleaning settings');
      let scan;
      if (draft?.draft) {                        // a published scan is never modified here: a new draft is made
        scan = await scansApi.reanalyze(draft.id, { cleaning, fpMethod: 'auto' });
      } else {
        scan = await scansApi.create({
          file: await sourceFile(source),
          name: sourceName(source),
          missionId: useMissionStore.getState().activeMissionId ?? undefined,
          draft: true,
          cleaning: JSON.stringify(cleaning),
          fpMethod: 'auto',
          minScore: 50,
          swathWidthM: swathWidthM || undefined,
        });
      }
      if (get().source !== source) {             // file changed while analysing: discard
        scansApi.remove(scan.id).catch(() => {});
        return null;
      }
      const top = [...(scan.detections ?? [])].sort((a, b) => b.confidence - a.confidence)[0];
      set({ draft: scan, detecting: false, selectedDetId: top?.id ?? null, threshold: scan.options?.minScore ?? 50 });
      const s = scan.summary ?? {};
      toast.success(`${s.candidates ?? 0} candidates: ${s.confirmed ?? 0} kept, ${s.suppressed ?? 0} rejected as false alarms`);
      return scan;
    } catch (err) {
      set({ detecting: false });
      toast.error(errorMessage(err));
      return null;
    }
  },

  setThreshold: (threshold) => set({ threshold }),
  selectDetection: (selectedDetId) => set({ selectedDetId }),

  /** Operator decision on one candidate: 'confirm' | 'reject' | 'clear' (saved immediately). */
  review: async (detId, decision) => {
    const status = { confirm: 'verified', reject: 'false_positive', clear: 'unreviewed' }[decision];
    try {
      const updated = await detectionsApi.review(detId, { status, origin: 'noise_filtration' });
      set((s) => ({
        draft: s.draft && {
          ...s.draft,
          detections: s.draft.detections.map((d) => (d.id === detId ? { ...d, review: updated.review } : d)),
        },
      }));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  },

  counts: () => {
    const { draft, threshold } = get();
    const dets = draft?.detections ?? [];
    let kept = 0;
    for (const d of dets) if (liveStatus(d, threshold).status === 'confirmed') kept += 1;
    return { kept, rejected: dets.length - kept, total: dets.length };
  },

  /** Publish the draft with the chosen threshold and decisions; it appears in AI Detection, the map and reports. */
  publish: async () => {
    const { draft, threshold } = get();
    if (!draft) return null;
    set({ publishing: true });
    try {
      const scan = await scansApi.publish(draft.id, { minScore: threshold });
      set({ draft: scan, publishing: false });
      useWorkspaceStore.getState().addSavedScan(scan);
      useMissionStore.getState().fetchMissions();
      toast.success(`Sent to AI Detection: ${scan.summary.confirmed} confirmed detection${scan.summary.confirmed === 1 ? '' : 's'}`);
      return scan;
    } catch (err) {
      set({ publishing: false });
      toast.error(errorMessage(err));
      return null;
    }
  },

  // ---------------------------------------------------------------- stage 3
  setStressOpts: (patch) => set((s) => ({ stressOpts: { ...s.stressOpts, ...patch } })),

  /** Region around the selected stage-2 detection (only when the AI cleaning kept the image geometry). */
  stressRoi: () => {
    const { draft, selectedDetId, stressOpts } = get();
    if (stressOpts.region !== 'selected' || !draft) return undefined;
    if (draft.processing?.cleaning?.frame?.geometry_changed) return undefined;
    const d = draft.detections?.find((x) => x.id === selectedDetId);
    if (!d) return undefined;
    const size = Math.max(1024, 3 * Math.max(d.bbox.width, d.bbox.height));
    const cx = (d.bbox.x1 + d.bbox.x2) / 2;
    const cy = (d.bbox.y1 + d.bbox.y2) / 2;
    const W = draft.source?.width ?? size;
    const H = draft.source?.height ?? size;
    const w = Math.min(size, W);
    const h = Math.min(size, H);
    const x = Math.round(Math.min(Math.max(0, cx - w / 2), W - w));
    const y = Math.round(Math.min(Math.max(0, cy - h / 2), H - h));
    return `${x},${y},${Math.round(w)},${Math.round(h)}`;
  },

  runStress: async () => {
    const { source, stressOpts } = get();
    const kinds = stressOpts.disturbances;
    if (!kinds.length) return toast.info('Pick at least one disturbance');
    const roi = get().stressRoi();
    set({ stressRun: { current: kinds[0], done: 0, total: kinds.length } });
    try {
      const file = await sourceFile(source);
      for (let i = 0; i < kinds.length; i += 1) {
        set({ stressRun: { current: kinds[i], done: i, total: kinds.length } });
        const result = await noiseApi.stress({ file, disturbance: kinds[i], levels: stressOpts.levels, roi });
        if (get().source !== source) return;
        set((s) => ({ stress: { ...s.stress, [kinds[i]]: result } }));
      }
      toast.success('Stress test finished');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      set({ stressRun: null });
    }
  },
}));
