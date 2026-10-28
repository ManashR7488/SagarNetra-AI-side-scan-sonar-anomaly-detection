import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity, ArrowRight, Check, CheckCircle2, Filter, Gauge, Layers, Loader2, Maximize, RotateCcw, ScanSearch, Send,
  ShieldCheck, Sparkles, Upload, Wand2,
} from "lucide-react";
import CandidateList from "../../components/noise/CandidateList";
import CleaningSettings from "../../components/noise/CleaningSettings";
import CompareSlider from "../../components/noise/CompareSlider";
import NoiseReport from "../../components/noise/NoiseReport";
import ReviewViewer from "../../components/noise/ReviewViewer";
import StepCards from "../../components/noise/StepCards";
import StressPanel from "../../components/noise/StressPanel";
import { SAMPLE_SCANS } from "../../data/sonarData";
import { useMissionStore } from "../../store/useMissionStore";
import { useNoiseStore } from "../../store/useNoiseStore";
import { cn } from "../../utils/cn";
import { DECISION_LABELS, NATURAL_META, PROFILE_META, STEP_META, liveStatus } from "../../utils/noise";

const STAGES = [
  { id: 1, label: "Clean signal", icon: Wand2, hint: "Speckle, gain, dropouts, motion, geometry" },
  { id: 2, label: "Reject false alarms", icon: ShieldCheck, hint: "Rocks, ripples, shadows · confidence 0-100%" },
  { id: 3, label: "Stress test", icon: Activity, hint: "Robustness to injected noise" },
];

function StageTabs({ stage, onStage, status }) {
  return (
    <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-1">
      {STAGES.map((s, i) => {
        const Icon = s.icon;
        return (
          <button key={s.id} type="button" onClick={() => onStage(s.id)} title={s.hint}
            className={cn("flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer transition-all",
              stage === s.id ? "bg-white text-blue-700 shadow-xs border border-blue-200" : "text-slate-600 hover:text-slate-900")}>
            <span className={cn("w-5 h-5 rounded-full flex items-center justify-center text-[10px]", stage === s.id ? "bg-blue-600 text-white" : "bg-slate-300 text-white")}>{i + 1}</span>
            <Icon className="w-3.5 h-3.5" />
            <span>{s.label}</span>
            {status[s.id] && <span className="text-[10px] font-mono font-normal text-slate-500">{status[s.id]}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ stage 1
function Stage1() {
  const profile = useNoiseStore((s) => s.profile);
  const results = useNoiseStore((s) => s.results);
  const edited = useNoiseStore((s) => s.edited);
  const loading = useNoiseStore((s) => s.loading);
  const selectedStep = useNoiseStore((s) => s.selectedStep);
  const fullRes = useNoiseStore((s) => s.fullRes);
  const { setProfile, autoClean, runClean, editParam, discardEdits, selectStep, loadFullRes } = useNoiseStore.getState();
  const [compareWith, setCompareWith] = useState("previous");   // previous | raw
  const [fullBusy, setFullBusy] = useState(false);

  const result = results[profile];
  const steps = result?.steps ?? [];
  const params = edited[profile] ?? result?.params;
  const dirty = Boolean(edited[profile]);
  const sel = steps.find((s) => s.id === selectedStep) ?? steps.find((s) => s.id === result?.final_step);
  const selIdx = sel ? steps.indexOf(sel) : -1;
  const before = compareWith === "raw" ? steps[0] : [...steps.slice(0, Math.max(selIdx, 1))].reverse().find((s) => s.image) ?? steps[0];
  const imgOf = (s) => (s ? fullRes[`${profile}:${s.id}`] ?? s.image : null);
  const isXtf = result?.source?.format === "xtf";

  const openFull = async () => {
    setFullBusy(true);
    await Promise.all([sel, before].filter(Boolean).map((s) => loadFullRes(s.id)));
    setFullBusy(false);
  };

  return (
    <div className="flex-1 grid grid-cols-12 gap-3 min-h-0">
      {/* settings */}
      <aside className="col-span-3 bg-white border border-slate-200 rounded-lg p-3 overflow-y-auto space-y-3 shadow-xs">
        <div>
          <div className="text-[11px] font-bold text-slate-800 uppercase tracking-wide mb-1.5">Output</div>
          <div className="grid grid-cols-2 gap-1 bg-slate-100 rounded-md p-1">
            {Object.entries(PROFILE_META).map(([k, m]) => (
              <button key={k} type="button" onClick={() => setProfile(k)}
                className={cn("py-1.5 rounded text-[11px] font-semibold cursor-pointer", profile === k ? "bg-white text-blue-700 shadow-xs" : "text-slate-600 hover:text-slate-900")}>
                {m.label}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-slate-500 mt-1.5 leading-snug">{PROFILE_META[profile].hint}</p>
        </div>

        <button type="button" onClick={autoClean} disabled={loading}
          className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {loading ? "Measuring & cleaning…" : "Auto clean"}
        </button>

        {dirty && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-2 space-y-1.5">
            <div className="text-[11px] text-amber-800 font-semibold">Settings changed</div>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => runClean({ auto: false })} disabled={loading} className="flex-1 py-1 rounded bg-amber-600 text-white text-[11px] font-semibold cursor-pointer disabled:opacity-60">Apply</button>
              <button type="button" onClick={discardEdits} className="px-2 py-1 rounded border border-amber-300 text-amber-800 text-[11px] cursor-pointer"><RotateCcw className="w-3 h-3" /></button>
            </div>
          </div>
        )}

        {result?.decisions?.length > 0 && !dirty && (
          <div>
            <div className="text-[11px] font-bold text-slate-800 uppercase tracking-wide mb-1">What Auto decided</div>
            <ul className="space-y-1">
              {result.decisions.map((d) => (
                <li key={d.step} className="flex gap-1.5 text-[10px] leading-snug">
                  {d.enabled ? <Check className="w-3 h-3 text-emerald-600 shrink-0 mt-0.5" /> : <span className="w-3 h-3 shrink-0 mt-0.5 text-slate-300 text-center">–</span>}
                  <span><b className={d.enabled ? "text-slate-800" : "text-slate-500"}>{DECISION_LABELS[d.step] ?? d.step}</b> <span className="text-slate-500">{d.why}</span></span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <div className="text-[11px] font-bold text-slate-800 uppercase tracking-wide mb-1.5">Advanced settings</div>
          <CleaningSettings params={params} onChange={editParam} xtf={isXtf} scaleKnown={Boolean(result?.diagnosis?.across_m_per_px)} />
        </div>
      </aside>

      {/* viewer */}
      <section className="col-span-6 flex flex-col gap-2 min-h-0">
        <div className="bg-white border border-slate-200 rounded-lg p-2 shadow-xs shrink-0">
          {steps.length ? <StepCards steps={steps} selected={sel?.id} onSelect={selectStep} /> : (
            <div className="h-[118px] flex items-center justify-center text-xs text-slate-400 gap-2">
              {loading ? <><Loader2 className="w-4 h-4 animate-spin" />Measuring the noise…</> : "Pick a sonar image or XTF log"}
            </div>
          )}
        </div>
        <div className="flex-1 bg-slate-950 rounded-lg relative min-h-0 overflow-hidden border border-slate-800">
          <CompareSlider
            before={imgOf(before)}
            after={imgOf(sel)}
            beforeLabel={before ? `${STEP_META[before.id]?.short ?? before.id}` : ""}
            afterLabel={sel ? `${STEP_META[sel.id]?.label ?? sel.id}` : ""}
            loading={loading}
            empty="No image yet"
          />
        </div>
        <div className="flex items-center gap-3 text-[10px] text-slate-500 shrink-0">
          <span>Compare with</span>
          {[["previous", "previous step"], ["raw", "raw input"]].map(([k, l]) => (
            <label key={k} className="flex items-center gap-1 cursor-pointer"><input type="radio" checked={compareWith === k} onChange={() => setCompareWith(k)} className="accent-blue-600" />{l}</label>
          ))}
          <span className="text-slate-300">|</span>
          <span>wheel = zoom · drag = pan · double-click = fit</span>
          <button type="button" onClick={openFull} disabled={!sel || fullBusy} className="ml-auto flex items-center gap-1 px-2 py-1 rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer disabled:opacity-50">
            {fullBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Maximize className="w-3 h-3" />}Full resolution
          </button>
          {result?.frame && (
            <span className="font-mono">{result.frame.width}×{result.frame.height}{result.frame.geometry_changed ? " · geometry corrected" : ""}{result.preview_side ? ` · preview ${result.preview_side}px` : ""}</span>
          )}
        </div>
      </section>

      {/* report */}
      <aside className="col-span-3 overflow-y-auto min-h-0">
        {result ? <NoiseReport result={result} showEvidence={profile === "ai"} /> : (
          <div className="bg-white border border-slate-200 rounded-lg p-4 text-xs text-slate-500">
            The noise report appears here: speckle, gain balance, ping stability, interference, lost pings and vehicle motion, before and after cleaning.
          </div>
        )}
      </aside>
    </div>
  );
}

// ------------------------------------------------------------------ stage 2
function Stage2() {
  const navigate = useNavigate();
  const draft = useNoiseStore((s) => s.draft);
  const detecting = useNoiseStore((s) => s.detecting);
  const publishing = useNoiseStore((s) => s.publishing);
  const threshold = useNoiseStore((s) => s.threshold);
  const selectedDetId = useNoiseStore((s) => s.selectedDetId);
  const aiResult = useNoiseStore((s) => s.results.ai);
  const aiEdited = useNoiseStore((s) => s.edited.ai);
  const missions = useMissionStore((s) => s.missions);
  const activeMissionId = useMissionStore((s) => s.activeMissionId);
  const { runDetection, setThreshold, selectDetection, review, publish } = useNoiseStore.getState();
  const [showRejected, setShowRejected] = useState(true);
  const [showShadows, setShowShadows] = useState(true);
  const [filter, setFilter] = useState("all");

  const dets = draft?.detections ?? [];
  const published = draft && !draft.draft;
  const live = useMemo(() => dets.map((d) => liveStatus(d, threshold)), [dets, threshold]);
  const kept = live.filter((l) => l.status === "confirmed").length;
  const byNatural = {};
  dets.forEach((d, i) => {
    if (live[i].status !== "confirmed" && d.natural?.label) byNatural[d.natural.label] = (byNatural[d.natural.label] ?? 0) + 1;
  });
  const overrides = live.filter((l) => l.override).length;
  const faf = draft?.processing?.falseAlarmFilter;
  const method = faf?.method ?? dets.find((d) => d.natural)?.natural?.method;
  // validation on real sonar (wreck sites the classifier never saw); pooled numbers when a model lacks the split
  const realCv = faf?.by_dataset?.ai4shipwrecks;
  const cvm = faf?.method === "classifier" ? realCv?.classifier ?? faf.cross_validated : null;
  const cvRules = realCv?.rules_baseline ?? faf?.rules_baseline;
  const simCv = faf?.by_dataset?.synthetic;
  const share = (v) => (v == null ? "–" : `${Math.round(v * 100)}%`);
  const auc = (m) => (m?.auc == null ? "–" : m.auc.toFixed(2));
  const mission = missions.find((m) => m.id === activeMissionId);
  const usedSteps = (draft?.processing?.cleaning?.steps ?? []).filter((s) => s.applied && s.id !== "raw").map((s) => STEP_META[s.id]?.short ?? s.id);

  const onPublish = async () => {
    const scan = await publish();
    if (scan) navigate("/app/ai-detection");
  };

  return (
    <div className="flex-1 grid grid-cols-12 gap-3 min-h-0">
      <section className="col-span-8 flex flex-col gap-2 min-h-0">
        <div className="bg-white border border-slate-200 rounded-lg p-2.5 flex flex-wrap items-center gap-3 shadow-xs shrink-0">
          <button type="button" onClick={runDetection} disabled={detecting}
            className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-xs font-semibold cursor-pointer disabled:opacity-60">
            {detecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ScanSearch className="w-4 h-4" />}
            {detecting ? "Cleaning & detecting…" : draft && !published ? "Re-run detection" : "Run detection on the AI input"}
          </button>
          <div className="flex items-center gap-2 min-w-[220px] flex-1">
            <Gauge className="w-4 h-4 text-slate-500 shrink-0" />
            <span className="text-[11px] text-slate-600 shrink-0">Confidence threshold</span>
            <input type="range" min={0} max={100} value={threshold} disabled={!draft || published} onChange={(e) => setThreshold(Number(e.target.value))} className="flex-1 accent-blue-600" />
            <span className="font-mono text-xs font-bold text-blue-700 w-9 text-right">{threshold}%</span>
          </div>
          <div className="text-[11px] font-mono">
            <span className="text-emerald-700 font-bold">{kept} kept</span> · <span className="text-slate-500">{dets.length - kept} rejected</span>
            {overrides > 0 && <span className="text-blue-700"> · {overrides} by you</span>}
          </div>
          <label className="flex items-center gap-1 text-[10px] text-slate-600 cursor-pointer"><input type="checkbox" checked={showRejected} onChange={(e) => setShowRejected(e.target.checked)} className="accent-blue-600" />rejected</label>
          <label className="flex items-center gap-1 text-[10px] text-slate-600 cursor-pointer"><input type="checkbox" checked={showShadows} onChange={(e) => setShowShadows(e.target.checked)} className="accent-violet-600" />shadows</label>
          {published ? (
            <button type="button" onClick={() => navigate("/app/ai-detection")} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-emerald-600 text-white cursor-pointer">
              <CheckCircle2 className="w-4 h-4" />Sent · open AI Detection
            </button>
          ) : (
            <button type="button" onClick={onPublish} disabled={!draft || publishing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer disabled:opacity-50"
              title="Save the scan with these decisions: it appears in AI Detection, the map, the dashboard and the reports">
              {publishing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}Send to AI Detection
            </button>
          )}
        </div>
        <div className="flex-1 bg-slate-950 rounded-lg relative min-h-0 overflow-hidden border border-slate-800">
          {draft ? (
            <ReviewViewer
              imageUrl={draft.images?.filtered?.url ?? draft.images?.annotated?.url}
              frame={draft.source ? { width: draft.source.width, height: draft.source.height } : null}
              detections={dets}
              threshold={threshold}
              selectedId={selectedDetId}
              onSelect={selectDetection}
              showRejected={showRejected}
              showShadows={showShadows}
              loading={detecting}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center p-6">
              <div className="max-w-lg text-center space-y-3">
                {detecting ? <Loader2 className="w-8 h-8 text-slate-400 animate-spin mx-auto" /> : <ShieldCheck className="w-10 h-10 text-slate-500 mx-auto" />}
                <p className="text-sm text-slate-200 font-semibold">Detection on the AI-cleaned scan, then false-alarm review</p>
                <p className="text-xs text-slate-400 leading-relaxed">
                  The scan is cleaned with the <b className="text-slate-200">AI input</b> settings from stage 1{aiEdited ? " (your edited settings)" : aiResult ? "" : " (computed now)"}, the
                  detector and segmenter run, and every candidate is checked for the evidence of a standing man-made object:
                  an attached acoustic shadow, straight edges, isolation from the surrounding texture. Rock clusters, sand ripples and
                  natural shadows are rejected with the reasons, and every candidate gets a 0-100% confidence.
                </p>
                <p className="text-[11px] text-slate-500">Nothing is added to the mission until you press “Send to AI Detection”.</p>
              </div>
            </div>
          )}
        </div>
      </section>

      <aside className="col-span-4 flex flex-col gap-2 min-h-0">
        <div className="bg-white border border-slate-200 rounded-lg p-2.5 space-y-1.5 shadow-xs shrink-0 text-[11px]">
          <div className="flex items-center justify-between">
            <span className="font-bold text-slate-800 uppercase tracking-wide">False-alarm filter</span>
            {method && method !== "off" && (
              <span className={cn("text-[10px] px-1.5 rounded border font-mono", method === "classifier" ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-slate-50 text-slate-600 border-slate-200")}
                title={cvm ? `Classifier v${faf.version}${faf.trained ? `, trained ${faf.trained}` : ""} on ${faf.training?.candidates ?? "?"} candidates${faf.classifier_weight < 1 ? `, blended ${Math.round(faf.classifier_weight * 100)}/${Math.round((1 - faf.classifier_weight) * 100)} with the rules` : ""}. Cross-validated on places it never saw: real sonar AUC ${auc(cvm)} (rules ${auc(cvRules)})${simCv ? `, simulated surveys AUC ${auc(simCv.classifier)} (rules ${auc(simCv.rules_baseline)})` : ""}.` : "Hand-set evidence rules (no trained classifier installed)"}>
                {method === "classifier" ? "trained classifier" : "rule-based"}
              </span>
            )}
          </div>
          {draft ? (
            <>
              <div className="flex flex-wrap gap-1">
                {Object.entries(byNatural).map(([k, n]) => (
                  <span key={k} className={cn("px-1.5 py-0.5 rounded border text-[10px]", NATURAL_META[k]?.badge)}>{NATURAL_META[k]?.label}: <b>{n}</b></span>
                ))}
                {!Object.keys(byNatural).length && <span className="text-slate-400 text-[10px]">no natural look-alikes rejected</span>}
              </div>
              {cvm && (
                <div className="text-[10px] text-slate-500 leading-snug">
                  Tested on {realCv ? "real sonar from wreck sites" : "survey areas"} it never saw: rejects <b className="text-slate-700">{share(cvm.false_alarms_rejected_at_95pct_recall)}</b> of
                  false alarms while keeping 95% of real objects{cvRules && <> (rule-based: {share(cvRules.false_alarms_rejected_at_95pct_recall)})</>}.
                </div>
              )}
              <div className="text-[10px] text-slate-500">AI input cleaning: {usedSteps.length ? usedSteps.join(" → ") : "none needed"}</div>
              <div className="text-[10px] text-slate-500">{published ? "Published to" : "Will be saved to"} <b>{draft.mission?.name ?? mission?.name ?? "General Survey"}</b></div>
            </>
          ) : (
            <div className="text-[10px] text-slate-400">Run detection to see the candidates.</div>
          )}
        </div>
        <div className="flex gap-1 shrink-0">
          {[["all", "All"], ["kept", "Kept"], ["rejected", "Rejected"]].map(([k, l]) => (
            <button key={k} type="button" onClick={() => setFilter(k)} className={cn("flex-1 py-1 rounded text-[11px] font-semibold border cursor-pointer", filter === k ? "bg-blue-600 text-white border-blue-600" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50")}>{l}</button>
          ))}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto pr-0.5">
          <CandidateList detections={dets} threshold={threshold} selectedId={selectedDetId} onSelect={selectDetection}
            onReview={(id, decision) => (published ? null : review(id, decision))} filter={filter} />
        </div>
      </aside>
    </div>
  );
}

// ------------------------------------------------------------------ stage 3
function Stage3() {
  const stressOpts = useNoiseStore((s) => s.stressOpts);
  const stressRun = useNoiseStore((s) => s.stressRun);
  const stress = useNoiseStore((s) => s.stress);
  const draft = useNoiseStore((s) => s.draft);
  const selectedDetId = useNoiseStore((s) => s.selectedDetId);
  const { setStressOpts, runStress } = useNoiseStore.getState();
  return (
    <div className="flex-1 min-h-0">
      <StressPanel opts={stressOpts} onOpts={setStressOpts} onRun={runStress} running={stressRun} results={stress}
        canUseSelected={Boolean(draft && selectedDetId)} geometryChanged={Boolean(draft?.processing?.cleaning?.frame?.geometry_changed)} />
    </div>
  );
}

// ------------------------------------------------------------------ tab
export default function NoiseFiltrationTab() {
  const source = useNoiseStore((s) => s.source);
  const stage = useNoiseStore((s) => s.stage);
  const swathWidthM = useNoiseStore((s) => s.swathWidthM);
  const results = useNoiseStore((s) => s.results);
  const draft = useNoiseStore((s) => s.draft);
  const threshold = useNoiseStore((s) => s.threshold);
  const stress = useNoiseStore((s) => s.stress);
  const { setSample, setFile, setSwath, setStage, runClean } = useNoiseStore.getState();

  // first visit: show a result straight away
  useEffect(() => {
    const s = useNoiseStore.getState();
    if (!s.results[s.profile] && !s.loading) runClean();
  }, [runClean]);

  const anyResult = results.analyst ?? results.ai;
  const isXtf = (source.kind === "file" && /\.xtf$/i.test(source.file.name)) || anyResult?.source?.format === "xtf";
  const kept = draft ? (draft.detections ?? []).filter((d) => liveStatus(d, threshold).status === "confirmed").length : null;
  const status = {
    1: anyResult?.report?.quality_before !== undefined ? `${anyResult.report.quality_before}→${anyResult.report.quality_after}` : null,
    2: draft ? `${kept}/${draft.detections?.length ?? 0}` : null,
    3: Object.keys(stress).length ? `${Object.keys(stress).length} done` : null,
  };

  return (
    <div className="flex flex-col h-full bg-slate-100 p-3 gap-3 overflow-hidden text-slate-900 font-sans">
      <div className="bg-white border border-slate-200 rounded-lg p-2.5 flex flex-wrap items-center justify-between gap-3 shrink-0 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-200">
            <Filter className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-900">Confidence Scoring &amp; Noise Filtering Module</h2>
            <p className="text-[11px] text-slate-500 font-mono">clean the sonar signal → reject natural false alarms → prove robustness</p>
          </div>
        </div>
        <StageTabs stage={stage} onStage={setStage} status={status} />
        <div className="flex items-center gap-2">
          <Layers className="w-3.5 h-3.5 text-slate-400" />
          <select
            value={source.kind === "sample" ? source.sample.id : ""}
            onChange={(e) => e.target.value && setSample(e.target.value)}
            className="bg-slate-50 border border-slate-300 text-slate-800 rounded-md px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer max-w-[220px]"
          >
            {source.kind === "file" && <option value="">{source.file.name}</option>}
            {SAMPLE_SCANS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <label className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium rounded-md border border-slate-300 cursor-pointer">
            <Upload className="w-3.5 h-3.5 text-blue-600" />Upload
            <input type="file" accept="image/*,.tif,.tiff,.xtf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) setFile(f); e.target.value = ""; }} />
          </label>
          {!isXtf && (
            <label className="flex items-center gap-1 text-[11px] text-slate-500" title="Images: the total swath width sets the pixel size (resolution step, metres in reports)">
              Swath
              <input type="number" min={1} value={swathWidthM} onChange={(e) => setSwath(e.target.value)} onBlur={() => swathWidthM && runClean()}
                placeholder="m" className="w-14 bg-slate-50 border border-slate-300 rounded px-1.5 py-1 text-xs font-mono" />
            </label>
          )}
          {stage < 3 && (
            <button type="button" onClick={() => setStage(stage + 1)} className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50 rounded-md cursor-pointer" title="Next stage">
              Next<ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {stage === 1 && <Stage1 />}
      {stage === 2 && <Stage2 />}
      {stage === 3 && <Stage3 />}
    </div>
  );
}
