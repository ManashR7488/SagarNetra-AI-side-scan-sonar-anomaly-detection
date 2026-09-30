import { create } from 'zustand';
import { scansApi } from '../api';
import { ApiError, errorMessage } from '../config/axios';
import { SAMPLE_PRESETS, SAMPLE_SCANS } from '../data/sonarData';
import { useMissionStore } from './useMissionStore';
import { toast } from './useToastStore';

const BATCH_CONCURRENCY = 2;

/** Image to show for a stored scan: the original, or the analysed waterfall for XTF logs. */
export const scanPreviewUrl = (scan) =>
  scan?.source?.format === 'xtf' ? scan?.images?.filtered?.url : scan?.source?.file?.url ?? scan?.images?.filtered?.url;

const savedItem = (scan) => ({
  key: scan.id,
  origin: 'saved',
  scanId: scan.id,
  name: scan.name || scan.source?.filename,
  previewUrl: scanPreviewUrl(scan),
  status: scan.status === 'completed' ? 'done' : scan.status === 'failed' ? 'failed' : 'analyzing',
  error: scan.error?.message,
  scan,
  hasDetails: Array.isArray(scan.detections),
});

async function fileForItem(item) {
  if (item.file) return item.file;
  const blob = await fetch(item.sample.image).then((r) => r.blob());
  return new File([blob], item.sample.filename, { type: blob.type });
}

function buildRequest(item, file, state) {
  const { options, georef, useDemoGeoref } = state;
  const fields = {
    file,
    name: item.name,
    missionId: useMissionStore.getState().activeMissionId ?? undefined,
    models: options.models,
    tiling: options.tiling,
    minScore: options.minScore,
    fpFilter: options.fpFilter,
    denoise: options.denoise,
    denoiseStrength: options.denoise === 'none' ? undefined : options.denoiseStrength,
  };
  if (georef.enabled) {
    Object.assign(fields, {
      latitude: georef.latitude, longitude: georef.longitude, headingDeg: georef.headingDeg,
      swathWidthM: georef.swathWidthM, anchor: georef.anchor, metadata: georef.navFile ?? undefined,
    });
  } else if (useDemoGeoref && item.sample) {
    Object.assign(fields, item.sample.demoGeoref);
  }
  return fields;
}

/**
 * AI Detection workspace: local (not yet analysed) files + scans saved in the backend for the active mission.
 * Kept in a global store so work survives switching tabs.
 */
export const useWorkspaceStore = create((set, get) => ({
  items: [],
  selectedKey: null,
  missionLoaded: undefined,   // mission id whose saved scans are in `items`
  loadingSaved: false,
  batch: { running: false, done: 0, total: 0 },

  options: { models: ['detector', 'segmenter'], minScore: 50, fpFilter: true, tiling: 'auto', denoise: 'none', denoiseStrength: 50 },
  georef: { enabled: false, latitude: '', longitude: '', headingDeg: '', swathWidthM: '', anchor: 'center', navFile: null },
  useDemoGeoref: true,

  setOptions: (patch) => set((s) => ({ options: { ...s.options, ...patch } })),
  setGeoref: (patch) => set((s) => ({ georef: { ...s.georef, ...patch } })),
  setUseDemoGeoref: (v) => set({ useDemoGeoref: v }),

  selected: () => get().items.find((i) => i.key === get().selectedKey) ?? get().items[0] ?? null,

  select: (key) => {
    set({ selectedKey: key });
    get().ensureDetails(key);
  },

  _update: (key, patch) => set((s) => ({ items: s.items.map((i) => (i.key === key ? { ...i, ...patch } : i)) })),

  addFiles: (fileList) => {
    const files = Array.from(fileList ?? []);
    if (!files.length) return;
    const added = files.map((file) => ({
      key: `local-${crypto.randomUUID()}`,
      origin: 'local',
      name: file.name,
      file,
      previewUrl: /\.xtf$/i.test(file.name) ? null : URL.createObjectURL(file),
      status: 'pending',
    }));
    set((s) => ({ items: [...added, ...s.items], selectedKey: added[0].key }));
    toast.info(`Loaded ${added.length} file${added.length > 1 ? 's' : ''}. Press Predict to analyse.`);
  },

  addSamples: (presetKey = 'all') => {
    const preset = SAMPLE_PRESETS[presetKey] ?? SAMPLE_PRESETS.all;
    const have = new Set(get().items.filter((i) => i.sample && i.origin === 'local').map((i) => i.sample.id));
    const added = SAMPLE_SCANS.filter(preset.filter).filter((s) => !have.has(s.id)).map((sample) => ({
      key: `sample-${sample.id}-${crypto.randomUUID()}`,
      origin: 'local',
      name: sample.name,
      sample,
      previewUrl: sample.image,
      status: 'pending',
    }));
    if (!added.length) return toast.info('Those samples are already in the workspace');
    set((s) => ({ items: [...added, ...s.items], selectedKey: added[0].key }));
    toast.info(`Added ${added.length} sample image${added.length > 1 ? 's' : ''}. Press Predict All to analyse.`);
  },

  /** Replace saved items with the scans of `missionId` (null = all missions); keeps local pending files. */
  loadSavedScans: async (missionId) => {
    set({ loadingSaved: true });
    try {
      const { data } = await scansApi.list({ missionId: missionId ?? undefined, limit: 100 });
      set((s) => {
        const local = s.items.filter((i) => i.origin === 'local');
        const items = [...local, ...data.map(savedItem)];
        const selectedKey = items.some((i) => i.key === s.selectedKey) ? s.selectedKey : items[0]?.key ?? null;
        return { items, selectedKey, missionLoaded: missionId, loadingSaved: false };
      });
      const sel = get().selectedKey;
      if (sel) get().ensureDetails(sel);
    } catch (err) {
      set({ loadingSaved: false });
      toast.error(errorMessage(err));
    }
  },

  /** Saved scans are listed without detections; fetch them when a scan is opened. */
  ensureDetails: async (key) => {
    const item = get().items.find((i) => i.key === key);
    if (!item?.scanId || item.hasDetails || item.loadingDetails) return;
    get()._update(key, { loadingDetails: true });
    try {
      const scan = await scansApi.get(item.scanId);
      get()._update(key, { scan, hasDetails: true, loadingDetails: false });
    } catch (err) {
      get()._update(key, { loadingDetails: false });
      toast.error(errorMessage(err));
    }
  },

  analyze: async (key, { quiet = false } = {}) => {
    const item = get().items.find((i) => i.key === key);
    if (!item || item.status === 'analyzing') return null;
    const { georef } = get();
    if (georef.enabled && (georef.latitude === '' || georef.longitude === '') && !georef.navFile) {
      toast.error('Georeference is enabled: enter latitude & longitude or attach a navigation file');
      return null;
    }
    get()._update(key, { status: 'analyzing', error: undefined, progress: 0 });
    try {
      let scan;
      if (item.origin === 'saved') {
        scan = await scansApi.reanalyze(item.scanId, {
          models: get().options.models.join(','), minScore: get().options.minScore, fpFilter: get().options.fpFilter,
          denoise: get().options.denoise,
        });
      } else {
        const file = await fileForItem(item);
        scan = await scansApi.create(buildRequest(item, file, get()), {
          onUploadProgress: (e) => e.total && get()._update(key, { progress: Math.round((e.loaded / e.total) * 100) }),
        });
      }
      if (item.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
      // The local item becomes the saved scan (same key so the selection stays).
      get()._update(key, { ...savedItem(scan), key, status: 'done', hasDetails: true, file: undefined });
      if (!quiet) {
        const s = scan.summary;
        toast.success(`${item.name}: ${s.confirmed} confirmed detection${s.confirmed === 1 ? '' : 's'}`
          + `${s.suppressed ? `, ${s.suppressed} suppressed` : ''}`);
      }
      return scan;
    } catch (err) {
      const scanId = err instanceof ApiError ? err.details?.scanId : undefined;
      get()._update(key, { status: 'failed', error: errorMessage(err), ...(scanId && { scanId }) });
      if (!quiet) toast.error(`${item.name}: ${errorMessage(err)}`);
      return null;
    } finally {
      useMissionStore.getState().fetchMissions();
    }
  },

  /** Analyse every pending / failed local item, a few at a time. */
  analyzeAll: async () => {
    const queue = get().items.filter((i) => i.origin === 'local' && ['pending', 'failed'].includes(i.status)).map((i) => i.key);
    if (!queue.length) return toast.info('Nothing to analyse: all images are already predicted');
    set({ batch: { running: true, done: 0, total: queue.length } });
    let failed = 0;
    const worker = async () => {
      while (queue.length) {
        const key = queue.shift();
        const scan = await get().analyze(key, { quiet: true });
        if (!scan) failed += 1;
        set((s) => ({ batch: { ...s.batch, done: s.batch.done + 1 } }));
      }
    };
    await Promise.all(Array.from({ length: BATCH_CONCURRENCY }, worker));
    const { total } = get().batch;
    set({ batch: { running: false, done: 0, total: 0 } });
    if (failed) toast.error(`Batch finished: ${total - failed} analysed, ${failed} failed`);
    else toast.success(`Batch finished: ${total} scans analysed and saved`);
  },

  removeItem: async (key) => {
    const item = get().items.find((i) => i.key === key);
    if (!item) return;
    if (item.origin === 'saved') {
      if (!window.confirm(`Delete scan "${item.name}" and its detections permanently?`)) return;
      try {
        await scansApi.remove(item.scanId);
        useMissionStore.getState().fetchMissions();
      } catch (err) {
        return toast.error(errorMessage(err));
      }
    }
    if (item.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
    set((s) => {
      const items = s.items.filter((i) => i.key !== key);
      return { items, selectedKey: s.selectedKey === key ? items[0]?.key ?? null : s.selectedKey };
    });
    toast.info(item.origin === 'saved' ? `Deleted scan "${item.name}"` : `Removed "${item.name}"`);
  },

  clearLocal: () => {
    get().items.filter((i) => i.origin === 'local' && i.previewUrl?.startsWith('blob:')).forEach((i) => URL.revokeObjectURL(i.previewUrl));
    set((s) => {
      const items = s.items.filter((i) => i.origin !== 'local');
      return { items, selectedKey: items[0]?.key ?? null };
    });
  },
}));
