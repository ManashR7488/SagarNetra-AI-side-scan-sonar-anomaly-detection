import { useEffect, useMemo, useState } from "react";
import {
  Upload,
  Play,
  Download,
  AlertTriangle,
  Image as ImageIcon,
  Map as MapIcon,
  CheckCircle2,
  Layers,
  Sparkles,
  MapPin,
  X,
  Loader2,
  Compass,
  RefreshCw,
  SlidersHorizontal,
  XCircle,
} from "lucide-react";
import { cn } from "../../utils/cn";
import { SAMPLE_PRESETS, SAMPLE_SCANS } from "../../data/sonarData";
import SonarMap from "../../components/SonarMap";
import DetectionViewer from "../../components/DetectionViewer";
import GeoreferenceDialog from "../../components/GeoreferenceDialog";
import { downloadUrl } from "../../api";
import { useMissionStore } from "../../store/useMissionStore";
import { useSystemStore } from "../../store/useSystemStore";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import { classColor, classLabel, SEVERITY_META, SUPPRESSION_LABELS } from "../../utils/classes";
import { downloadFromUrl } from "../../utils/download";
import { detectionLatLng, fmtBytes, fmtLat, fmtLon, fmtMs, fmtNum, fmtPoint } from "../../utils/format";

const SAMPLE_NAMES = new Set(SAMPLE_SCANS.map((s) => s.name));

const mapTest = (card) => card?.test_metrics?.box?.find((r) => r.class === "ALL")?.mAP50;

function StatusBadge({ item }) {
  if (item.status === "analyzing") {
    return (
      <div className="absolute bottom-1.5 right-1.5 z-10 bg-blue-600/95 text-white text-[9px] font-mono font-bold px-1.5 py-0.5 rounded flex items-center gap-1 border border-blue-400/40">
        <Loader2 className="w-2.5 h-2.5 animate-spin" />
        <span>{item.progress !== undefined && item.progress < 100 ? `UPLOAD ${item.progress}%` : "ANALYSING"}</span>
      </div>
    );
  }
  if (item.status === "done") {
    return (
      <div className="absolute bottom-1.5 right-1.5 z-10 bg-emerald-600/95 text-white text-[9px] font-mono font-bold px-1.5 py-0.5 rounded flex items-center gap-1 shadow-sm border border-emerald-400/40">
        <CheckCircle2 className="w-2.5 h-2.5" />
        <span>PREDICTED</span>
      </div>
    );
  }
  if (item.status === "failed") {
    return (
      <div className="absolute bottom-1.5 right-1.5 z-10 bg-red-600/95 text-white text-[9px] font-mono font-bold px-1.5 py-0.5 rounded flex items-center gap-1" title={item.error}>
        <XCircle className="w-2.5 h-2.5" />
        <span>FAILED</span>
      </div>
    );
  }
  return (
    <div className="absolute bottom-1.5 right-1.5 z-10 bg-slate-800/90 text-slate-300 text-[9px] font-mono px-1.5 py-0.5 rounded border border-slate-700">
      {item.origin === "local" ? "NOT ANALYSED" : "RAW"}
    </div>
  );
}

function InfoRow({ label, children, title }) {
  return (
    <div className="flex justify-between gap-2 border-b border-slate-100 pb-1 last:border-0" title={title}>
      <span className="text-slate-400 shrink-0">{label}</span>
      <span className="font-medium text-slate-800 truncate text-right">{children}</span>
    </div>
  );
}

export default function AiDetectionTab() {
  const activeMissionId = useMissionStore((s) => s.activeMissionId);
  const models = useSystemStore((s) => s.models);

  const items = useWorkspaceStore((s) => s.items);
  const selectedKey = useWorkspaceStore((s) => s.selectedKey);
  const missionLoaded = useWorkspaceStore((s) => s.missionLoaded);
  const loadingSaved = useWorkspaceStore((s) => s.loadingSaved);
  const batch = useWorkspaceStore((s) => s.batch);
  const options = useWorkspaceStore((s) => s.options);
  const georef = useWorkspaceStore((s) => s.georef);
  const useDemoGeoref = useWorkspaceStore((s) => s.useDemoGeoref);
  const { setOptions, select, addFiles, addSamples, loadSavedScans, analyze, analyzeAll, removeItem, clearLocal, ensureDetails } =
    useWorkspaceStore.getState();

  const [viewMode, setViewMode] = useState("image");
  const [showRoute, setShowRoute] = useState(false);
  const [overlayMode, setOverlayMode] = useState("overlay"); // overlay | annotated
  const [showSuppressed, setShowSuppressed] = useState(false);
  const [showMasks, setShowMasks] = useState(true);
  const [selectedDetId, setSelectedDetId] = useState(null);
  const [georefOpen, setGeorefOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Load the saved scans of the active mission (keeps not-yet-analysed local files).
  useEffect(() => {
    if (missionLoaded !== activeMissionId) loadSavedScans(activeMissionId);
  }, [activeMissionId, missionLoaded, loadSavedScans]);

  // A mission was deleted: its scans are gone from the database, reload the list.
  const dataVersion = useMissionStore((s) => s.dataVersion);
  useEffect(() => {
    if (dataVersion) loadSavedScans(useMissionStore.getState().activeMissionId);
  }, [dataVersion, loadSavedScans]);

  const selected = items.find((i) => i.key === selectedKey) ?? items[0] ?? null;
  const scan = selected?.scan;
  const detections = useMemo(() => scan?.detections ?? [], [scan]);
  const confirmed = detections.filter((d) => d.status === "confirmed");
  const selectedDet = detections.find((d) => d.id === selectedDetId) ?? null;
  const doneCount = items.filter((i) => i.status === "done").length;
  const pendingCount = items.filter((i) => i.origin === "local" && ["pending", "failed"].includes(i.status)).length;
  const isBusy = batch.running || selected?.status === "analyzing";

  useEffect(() => setSelectedDetId(null), [selectedKey]);

  // The map needs detections of every analysed scan: fetch the missing ones when the map is opened.
  useEffect(() => {
    if (viewMode !== "map") return;
    items.filter((i) => i.status === "done" && !i.hasDetails).forEach((i) => ensureDetails(i.key));
  }, [viewMode, items, ensureDetails]);

  const mapPins = useMemo(() => items.flatMap((i) => (i.scan?.detections ?? [])
    .filter((d) => d.status === "confirmed" && detectionLatLng(d))
    .map((d) => ({
      ...detectionLatLng(d),
      id: d.id,
      code: d.code,
      title: i.name,
      scanKey: i.key,
      className: d.className,
      confidence: d.confidence,
      severity: d.severity,
      reviewStatus: d.review?.status,
      dimensions: d.dimensions,
    }))), [items]);

  const tracks = useMemo(() => items
    .filter((i) => i.scan?.georeference?.track?.coordinates?.length > 1)
    .map((i) => ({ id: i.key, label: i.name, positions: i.scan.georeference.track.coordinates.map(([lon, lat]) => [lat, lon]) })), [items]);

  const detector = models?.detector;
  const segmenter = models?.segmenter;
  const modelButtons = [
    { role: "detector", title: detector ? `${detector.architecture.toUpperCase()} detector · ${detector.classes.length} classes` : "Detector", map50: mapTest(detector) },
    { role: "segmenter", title: segmenter ? `${segmenter.architecture.toUpperCase()} wreck segmenter` : "Segmenter", map50: mapTest(segmenter) },
  ];
  const toggleModel = (role) => {
    const next = options.models.includes(role) ? options.models.filter((m) => m !== role) : [...options.models, role];
    if (next.length) setOptions({ models: next });
  };

  const georefLabel = georef.enabled ? "Manual" : useDemoGeoref ? "Demo (samples)" : "None";
  const isDemoPosition = scan?.georeference?.source === "simple" && SAMPLE_NAMES.has(scan?.name);
  const topDet = confirmed[0];

  const viewerImage = overlayMode === "annotated" && scan?.images?.annotated?.url ? scan.images.annotated.url : selected?.previewUrl;

  return (
    <div className="flex flex-col h-full bg-slate-100 p-3 gap-3 overflow-hidden text-slate-900 font-sans select-none relative">
      {/* Models & analysis settings */}
      <div className="flex flex-wrap items-center border border-slate-200 bg-white rounded-lg overflow-hidden shrink-0 shadow-xs">
        <div className="px-4 py-2 bg-slate-50 border-r border-slate-200 text-xs font-mono font-bold text-slate-600 flex items-center gap-1.5">
          <Layers className="w-3.5 h-3.5 text-blue-600" />
          <span>MODELS:</span>
        </div>
        <div className="flex flex-1 min-w-0 divide-x divide-slate-200">
          {modelButtons.map((m) => {
            const on = options.models.includes(m.role);
            return (
              <button
                key={m.role}
                type="button"
                onClick={() => toggleModel(m.role)}
                title={on ? "Click to disable (at least one model must stay on)" : "Click to enable"}
                className={cn(
                  "flex-1 py-2 text-center text-xs font-semibold transition-all flex items-center justify-center gap-2 cursor-pointer",
                  on ? "bg-blue-600 text-white shadow-xs" : "bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-900",
                )}
              >
                <span className={cn("w-2 h-2 rounded-full", on ? "bg-emerald-300" : "bg-slate-300")} />
                <span>{m.title}</span>
                {m.map50 !== undefined && <span className="text-[10px] font-mono opacity-80">test mAP50 {m.map50.toFixed(2)}</span>}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => setSettingsOpen((v) => !v)}
          className={cn("px-3 py-2 border-l border-slate-200 text-xs font-semibold flex items-center gap-1.5 cursor-pointer", settingsOpen ? "bg-blue-50 text-blue-700" : "bg-slate-50 text-slate-600 hover:bg-slate-100")}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
          Min score {options.minScore}% · FP filter {options.fpFilter ? "on" : "off"}
        </button>
      </div>

      {settingsOpen && (
        <div className="bg-white border border-slate-200 rounded-lg px-4 py-2.5 shadow-xs grid grid-cols-4 gap-4 text-xs shrink-0">
          <label className="flex flex-col gap-1">
            <span className="flex justify-between font-semibold text-slate-700">Minimum confidence score <span className="font-mono text-blue-600">{options.minScore}%</span></span>
            <input type="range" min="0" max="100" value={options.minScore} onChange={(e) => setOptions({ minScore: Number(e.target.value) })} className="accent-blue-600" />
            <span className="text-[10px] text-slate-400">50 = each class's calibrated decision threshold</span>
          </label>
          <label className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" checked={options.fpFilter} onChange={(e) => setOptions({ fpFilter: e.target.checked })} className="accent-blue-600 mt-0.5" />
            <span><span className="font-semibold text-slate-700 block">False-positive filter</span><span className="text-[10px] text-slate-400">Shadow / edge / contrast evidence; suppresses marine life, speckle and dropouts</span></span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-semibold text-slate-700">Pre-inference despeckle</span>
            <select value={options.denoise} onChange={(e) => setOptions({ denoise: e.target.value })} className="bg-slate-50 border border-slate-300 rounded-md px-2 py-1 font-mono">
              {["none", "lee", "frost", "kuan", "median"].map((m) => <option key={m} value={m}>{m === "none" ? "None (recommended)" : m}</option>)}
            </select>
            <span className="text-[10px] text-slate-400">Models were trained on speckled data</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-semibold text-slate-700">Tiling</span>
            <select value={options.tiling} onChange={(e) => setOptions({ tiling: e.target.value })} className="bg-slate-50 border border-slate-300 rounded-md px-2 py-1 font-mono">
              <option value="auto">Auto (long strips tiled)</option>
              <option value="on">Always tile</option>
              <option value="off">Never tile</option>
            </select>
          </label>
        </div>
      )}

      {/* Action toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-white border border-slate-200 px-3 py-2 rounded-lg shrink-0 shadow-xs">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 px-3.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-md text-xs font-semibold cursor-pointer border border-slate-300 transition-colors shadow-2xs">
            <Upload className="w-3.5 h-3.5 text-blue-600" />
            <span>Load Image(s) / XTF</span>
            <input type="file" accept="image/*,.tif,.tiff,.xtf" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          </label>

          <button
            type="button"
            onClick={() => setGeorefOpen(true)}
            className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold border transition-colors cursor-pointer shadow-2xs",
              georef.enabled ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-slate-100 text-slate-700 border-slate-300 hover:bg-slate-200")}
            title="Survey position / navigation used to geotag detections"
          >
            <Compass className="w-3.5 h-3.5 text-blue-600" />
            <span>Georef: {georefLabel}</span>
          </button>

          <button
            type="button"
            onClick={() => selected && analyze(selected.key)}
            disabled={!selected || isBusy}
            className={cn(
              "flex items-center gap-2 px-4 py-1.5 rounded-md text-xs font-semibold transition-all cursor-pointer shadow-2xs disabled:cursor-not-allowed",
              !selected ? "bg-slate-200 text-slate-400"
                : selected.status === "analyzing" ? "bg-blue-400 text-white cursor-wait"
                : selected.status === "done" ? "bg-emerald-600 text-white hover:bg-emerald-700"
                : "bg-blue-600 hover:bg-blue-700 text-white",
            )}
            title={selected?.status === "done" ? "Re-run the AI on the stored original with the current settings" : "Analyse the selected image"}
          >
            {selected?.status === "analyzing" ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : selected?.status === "done" ? <RefreshCw className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            <span>{selected?.status === "analyzing" ? "Analysing…" : selected?.status === "done" ? "Re-analyse" : "Predict"}</span>
          </button>

          <button
            type="button"
            onClick={analyzeAll}
            disabled={batch.running || pendingCount === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md text-xs font-semibold border border-slate-300 transition-colors cursor-pointer shadow-2xs disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {batch.running ? <Loader2 className="w-3 h-3 animate-spin text-blue-600" /> : <Sparkles className="w-3 h-3 text-blue-600" />}
            <span>{batch.running ? `Analysing ${batch.done}/${batch.total}` : `Predict All (${pendingCount})`}</span>
          </button>

          <div className="flex items-center rounded-md border border-slate-300 overflow-hidden shadow-2xs">
            <span className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-100 text-slate-800 text-xs font-semibold">
              <Download className="w-3.5 h-3.5 text-emerald-600" />Report
            </span>
            {["json", "csv"].map((fmt) => (
              <button
                key={fmt}
                type="button"
                disabled={!scan?.id || selected?.status !== "done"}
                onClick={() => downloadFromUrl(downloadUrl(`/scans/${scan.id}/report.${fmt}`))}
                className="px-2 py-1.5 text-[11px] font-mono font-bold bg-white hover:bg-slate-50 border-l border-slate-300 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer uppercase"
              >
                {fmt}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            value=""
            onChange={(e) => {
              const v = e.target.value;
              if (v === "clear") clearLocal();
              else if (v) addSamples(v);
            }}
            className="bg-slate-50 border border-slate-300 text-slate-800 rounded-md px-2.5 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
          >
            <option value="">Add samples…</option>
            {Object.entries(SAMPLE_PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
            <option value="clear">Clear un-analysed files</option>
          </select>

          <div className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-300 shadow-2xs">
            <button type="button" onClick={() => setViewMode("image")} className={cn("flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold transition-all cursor-pointer", viewMode === "image" ? "bg-white text-blue-600 shadow-xs border border-slate-200" : "text-slate-600 hover:text-slate-900")}>
              <ImageIcon className="w-3.5 h-3.5" /><span>Image View</span>
            </button>
            <button type="button" onClick={() => setViewMode("map")} className={cn("flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold transition-all cursor-pointer", viewMode === "map" ? "bg-white text-blue-600 shadow-xs border border-slate-200" : "text-slate-600 hover:text-slate-900")}>
              <MapIcon className="w-3.5 h-3.5" /><span>Map View</span>
              {mapPins.length > 0 && <span className="ml-0.5 px-1.5 text-[10px] font-mono bg-blue-100 text-blue-700 rounded-full font-bold">{mapPins.length}</span>}
            </button>
          </div>
        </div>
      </div>

      {/* Main: scan gallery (left) + predicted image or map (right) */}
      <div className="flex-1 grid grid-cols-12 gap-3 min-h-0">
        <div className="col-span-6 bg-white border border-slate-200 rounded-lg overflow-hidden flex flex-col shadow-xs min-h-0">
          <div className="bg-slate-50 border-b border-slate-200 px-3 py-2 flex justify-between items-center text-xs shrink-0">
            <div className="flex items-center gap-2">
              <span className="font-mono font-bold text-slate-900 uppercase tracking-wide">SONAR SCANS ({items.length})</span>
              {loadingSaved && <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" />}
            </div>
            <span className="text-[10px] font-mono text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded font-bold">
              {doneCount} / {items.length} PREDICTED
            </span>
          </div>

          <div className="flex-1 overflow-y-auto p-2.5 bg-slate-50/50 min-h-0">
            {items.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400">
                <Upload className="w-10 h-10 text-slate-300 mb-2" />
                <p className="text-xs font-semibold text-slate-600 mb-1">No sonar scans in this mission yet</p>
                <p className="text-[11px] text-slate-400 max-w-xs mb-4">Load side-scan images or XTF logs, or add the bundled samples, then press Predict.</p>
                <button type="button" onClick={() => addSamples("all")} className="px-3 py-1.5 bg-blue-600 text-white rounded text-xs font-semibold hover:bg-blue-700 cursor-pointer">
                  Add Sample Dataset
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2.5">
                {items.map((item) => {
                  const isSelected = item.key === selected?.key;
                  const done = item.status === "done";
                  const top = item.scan?.detections?.find((d) => d.status === "confirmed");
                  const confirmedCount = item.scan?.summary?.confirmed;
                  return (
                    <div
                      key={item.key}
                      onClick={() => select(item.key)}
                      className={cn(
                        "group relative rounded-lg overflow-hidden cursor-pointer transition-all duration-200 bg-slate-950 flex flex-col",
                        done ? "border-2 border-emerald-500 shadow-sm" : item.status === "failed" ? "border-2 border-red-400" : "border border-slate-300 opacity-85 hover:opacity-100",
                        isSelected && "ring-2 ring-blue-600 ring-offset-2 ring-offset-white",
                      )}
                    >
                      <div className="relative aspect-[4/3] w-full bg-slate-950 overflow-hidden flex items-center justify-center">
                        {item.previewUrl ? (
                          <img src={item.previewUrl} alt={item.name} loading="lazy" className="w-full h-full object-cover filter grayscale contrast-125 group-hover:scale-105 transition-transform duration-300" />
                        ) : (
                          <span className="text-[10px] font-mono text-slate-400">XTF LOG</span>
                        )}
                        {item.sample && item.origin === "local" && (
                          <div className="absolute top-1.5 left-1.5 bg-black/80 text-white text-[9px] font-mono px-1.5 py-0.5 rounded border border-white/20 z-10">SAMPLE</div>
                        )}
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); removeItem(item.key); }}
                          className="absolute top-1.5 right-1.5 z-30 w-5 h-5 rounded-full bg-black/80 hover:bg-red-600 text-white flex items-center justify-center transition-all cursor-pointer shadow-md border border-white/30"
                          title={item.origin === "saved" ? `Delete scan ${item.name}` : `Remove ${item.name}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                        <StatusBadge item={item} />
                      </div>
                      <div className={cn("p-1.5 text-[10px] font-mono flex items-center justify-between gap-1 border-t",
                        done ? "bg-emerald-950/80 text-emerald-200 border-emerald-800/60" : "bg-slate-900 text-slate-300 border-slate-800")}>
                        <span className="truncate font-semibold" title={item.name}>{done && top ? classLabel(top.className) : item.name}</span>
                        <span className="font-bold shrink-0">
                          {done ? (top ? `${top.confidence.toFixed(0)}%${confirmedCount > 1 ? ` +${confirmedCount - 1}` : ""}` : "clear") : ""}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="bg-slate-50 border-t border-slate-200 px-3 py-1.5 flex items-center justify-between text-[11px] font-mono text-slate-600 shrink-0">
            <span className="truncate max-w-[45%]">SELECTED: <strong className="text-slate-900">{selected?.name ?? "—"}</strong></span>
            <span>STATUS: <strong className={selected?.status === "done" ? "text-emerald-600" : selected?.status === "failed" ? "text-red-600" : "text-amber-600"}>
              {selected ? { done: "AI ANALYSED", failed: "FAILED", analyzing: "ANALYSING", pending: "AWAITING PREDICTION" }[selected.status] : "—"}
            </strong></span>
          </div>
        </div>

        <div className="col-span-6 bg-white border border-slate-200 rounded-lg overflow-hidden flex flex-col shadow-xs min-h-0">
          {viewMode === "image" && (
            <>
              <div className="bg-slate-50 border-b border-slate-200 px-3 py-2 z-20 flex justify-between items-center text-xs shrink-0 gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-2 h-2 rounded-full bg-blue-600 shrink-0" />
                  <span className="font-mono font-bold text-slate-900 uppercase tracking-wide truncate">PREDICTED IMAGE • {selected?.name ?? "—"}</span>
                </div>
                {selected?.status === "done" ? (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <div className="flex items-center bg-white border border-slate-300 rounded overflow-hidden text-[10px] font-mono font-bold">
                      {[["overlay", "Overlay"], ["annotated", "Server render"]].map(([k, l]) => (
                        <button key={k} type="button" onClick={() => setOverlayMode(k)} className={cn("px-1.5 py-0.5 cursor-pointer", overlayMode === k ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-100")}>{l}</button>
                      ))}
                    </div>
                    {overlayMode === "overlay" && (
                      <>
                        <label className="flex items-center gap-1 text-[10px] font-mono text-slate-600 cursor-pointer"><input type="checkbox" checked={showMasks} onChange={(e) => setShowMasks(e.target.checked)} className="accent-blue-600" />Masks</label>
                        <label className="flex items-center gap-1 text-[10px] font-mono text-slate-600 cursor-pointer"><input type="checkbox" checked={showSuppressed} onChange={(e) => setShowSuppressed(e.target.checked)} className="accent-blue-600" />Suppressed</label>
                      </>
                    )}
                    <span className={cn("text-[11px] font-mono border px-2 py-0.5 rounded font-bold flex items-center gap-1",
                      confirmed.length ? "bg-red-50 text-red-700 border-red-200" : "bg-emerald-50 text-emerald-700 border-emerald-200")}>
                      {confirmed.length ? <AlertTriangle className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />}
                      {confirmed.length ? `${confirmed.length} DETECTION${confirmed.length > 1 ? "S" : ""}` : "NO HAZARDS"}
                    </span>
                  </div>
                ) : (
                  <span className="text-[10px] font-mono bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded font-bold shrink-0">
                    {selected?.status === "failed" ? "ANALYSIS FAILED" : "PREDICTION PENDING"}
                  </span>
                )}
              </div>

              <div className="flex-1 relative bg-slate-950 overflow-hidden min-h-0 m-0">
                <div className="absolute inset-2">
                  {selected ? (
                    <DetectionViewer
                      imageUrl={viewerImage}
                      frame={overlayMode === "overlay" && scan?.source ? { width: scan.source.width, height: scan.source.height } : null}
                      detections={overlayMode === "overlay" && selected.status === "done" ? detections : []}
                      selectedId={selectedDetId}
                      onSelect={(d) => setSelectedDetId(d.id)}
                      showSuppressed={showSuppressed}
                      showMasks={showMasks}
                      loading={selected.status === "analyzing" || selected.loadingDetails}
                      imageClassName="filter contrast-110"
                    />
                  ) : null}
                </div>
                <div className="absolute inset-0 pointer-events-none opacity-10 bg-[linear-gradient(to_right,#3b82f6_1px,transparent_1px),linear-gradient(to_bottom,#3b82f6_1px,transparent_1px)] bg-[size:36px_36px]" />

                {selected && selected.status !== "done" && selected.status !== "analyzing" && (
                  <div className="absolute bottom-4 left-4 right-4 bg-white/95 backdrop-blur-md border border-slate-200 rounded-lg p-3 text-xs text-slate-800 font-mono shadow-md flex items-center justify-between gap-3 z-20">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={cn("w-2 h-2 rounded-full shrink-0", selected.status === "failed" ? "bg-red-500" : "bg-amber-500 animate-pulse")} />
                      <span className="text-slate-600 truncate" title={selected.error}>
                        {selected.status === "failed" ? `Failed: ${selected.error}` : "This image has not been analysed yet."}
                      </span>
                    </div>
                    <button type="button" onClick={() => analyze(selected.key)} disabled={isBusy} className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-md text-xs flex items-center gap-1.5 cursor-pointer shadow-xs disabled:opacity-50 shrink-0">
                      <Sparkles className="w-3.5 h-3.5" /><span>{selected.status === "failed" ? "Retry" : "Run AI Prediction"}</span>
                    </button>
                  </div>
                )}
              </div>

              <div className="bg-slate-50 border-t border-slate-200 px-3 py-1.5 flex items-center justify-between text-[11px] font-mono text-slate-600 shrink-0 gap-3">
                {selectedDet || topDet ? (() => {
                  const d = selectedDet ?? topDet;
                  return (
                    <>
                      <span className="truncate">{d.code}: <strong style={{ color: classColor(d.className) }}>{classLabel(d.className)}</strong> {d.confidence.toFixed(1)}%</span>
                      <span>POS: <strong className="text-slate-900">{fmtPoint(d.location)}</strong></span>
                      <span>SIZE: <strong className="text-blue-600">{d.dimensions ? `${fmtNum(d.dimensions.alongTrackM)} × ${fmtNum(d.dimensions.acrossTrackM)} m` : "—"}</strong></span>
                    </>
                  );
                })() : <span className="text-slate-400">{selected?.status === "done" ? "No confirmed detections in this scan" : "Run a prediction to see detections"}</span>}
              </div>
            </>
          )}

          {viewMode === "map" && (
            <div className="flex-1 flex flex-col min-h-0 relative">
              <div className="flex-1 relative min-h-0">
                <SonarMap
                  pinnedLocations={mapPins}
                  tracks={tracks}
                  activeLocation={selectedDet ? detectionLatLng(selectedDet) : null}
                  showCleaningRoute={showRoute}
                  onToggleCleaningRoute={setShowRoute}
                  onSelectPin={(pin) => { select(pin.scanKey); setTimeout(() => setSelectedDetId(pin.id), 0); }}
                />
                {mapPins.length === 0 && (
                  <div className="absolute inset-0 z-[1100] bg-slate-900/60 backdrop-blur-xs flex flex-col items-center justify-center text-center p-6 text-white">
                    <MapPin className="w-10 h-10 text-amber-400 mb-2 animate-bounce" />
                    <h4 className="font-bold text-base mb-1">No geotagged detections yet</h4>
                    <p className="text-xs text-slate-200 max-w-sm mb-4">
                      Predictions are placed on the map when the scan has a georeference: an XTF log, a navigation file, a position entered under
                      &quot;Georef&quot;, or the demo positions of the bundled samples.
                    </p>
                    <button type="button" onClick={analyzeAll} disabled={batch.running || pendingCount === 0} className="px-4 py-2 bg-blue-600 text-white rounded-md text-xs font-bold hover:bg-blue-700 shadow-md cursor-pointer flex items-center gap-1.5 disabled:opacity-50">
                      <Play className="w-3.5 h-3.5" /><span>Predict All ({pendingCount})</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Real scan data: file & processing | georeference | detections */}
      <div className="h-44 grid grid-cols-4 gap-3 shrink-0">
        <div className="col-span-1 bg-white border border-slate-200 rounded-lg p-3 text-[11px] font-mono text-slate-700 shadow-xs overflow-hidden">
          <div className="text-[10px] font-bold text-slate-500 uppercase mb-1.5">Scan & processing</div>
          <div className="space-y-1">
            <InfoRow label="File">{scan?.source?.filename ?? selected?.name ?? "—"}</InfoRow>
            <InfoRow label="Format / size">{scan?.source ? `${scan.source.format?.toUpperCase()} · ${fmtBytes(scan.source.sizeBytes)}` : selected?.file ? fmtBytes(selected.file.size) : "—"}</InfoRow>
            <InfoRow label="Image">{scan?.source?.width ? `${scan.source.width} × ${scan.source.height} px` : "—"}</InfoRow>
            <InfoRow label="Inference">{scan?.processing ? `${fmtMs(scan.processing.timings?.total_ms)} · ${scan.processing.tiled ? `${scan.processing.tiles} tiles` : "whole image"}` : "—"}</InfoRow>
            <InfoRow label="End-to-end">{fmtMs(scan?.processing?.durationMs)}</InfoRow>
          </div>
        </div>

        <div className="col-span-1 bg-white border border-slate-200 rounded-lg p-3 text-[11px] font-mono text-slate-700 shadow-xs overflow-hidden">
          <div className="text-[10px] font-bold text-slate-500 uppercase mb-1.5 flex items-center justify-between">
            <span>Georeference</span>
            {isDemoPosition && <span className="text-[9px] bg-amber-50 text-amber-700 border border-amber-200 px-1 rounded">DEMO POSITION</span>}
          </div>
          {scan?.georeference?.available ? (
            <div className="space-y-1">
              <InfoRow label="Source">{scan.georeference.source?.replaceAll("_", " ")}</InfoRow>
              <InfoRow label="Start">{fmtLat(scan.georeference.start?.coordinates?.[1], 4)}, {fmtLon(scan.georeference.start?.coordinates?.[0], 4)}</InfoRow>
              <InfoRow label="Heading">{fmtNum(scan.georeference.meanHeadingDeg, 1, "°")}</InfoRow>
              <InfoRow label="Resolution">{fmtNum(scan.georeference.acrossTrackMPerPx * 100, 1)} cm/px</InfoRow>
              <InfoRow label="Assumptions" title={scan.georeference.assumptions?.join("\n")}>{scan.georeference.assumptions?.length ? `${scan.georeference.assumptions.length} (hover)` : "none"}</InfoRow>
            </div>
          ) : (
            <p className="text-slate-400 leading-relaxed">
              {scan ? scan.georeference?.reason ?? "Not georeferenced" : "Analyse a scan to see its georeference."}
            </p>
          )}
        </div>

        <div className="col-span-2 bg-white border border-slate-200 rounded-lg shadow-xs flex flex-col min-h-0 overflow-hidden">
          <div className="px-3 py-1.5 border-b border-slate-100 text-[10px] font-mono font-bold text-slate-500 uppercase flex justify-between">
            <span>Detections ({detections.length})</span>
            {scan?.summary && <span>{scan.summary.confirmed} confirmed · {scan.summary.suppressed} suppressed</span>}
          </div>
          <div className="flex-1 overflow-y-auto min-h-0">
            {detections.length === 0 ? (
              <div className="h-full flex items-center justify-center text-[11px] font-mono text-slate-400">
                {selected?.status === "done" ? "The models found nothing in this scan." : "No detections yet."}
              </div>
            ) : (
              <table className="w-full text-[11px] font-mono">
                <thead className="bg-slate-50 text-slate-500 text-[10px] sticky top-0">
                  <tr>
                    <th className="text-left px-2 py-1">ID</th>
                    <th className="text-left px-2 py-1">Class</th>
                    <th className="text-right px-2 py-1">Conf</th>
                    <th className="text-left px-2 py-1">Status</th>
                    <th className="text-left px-2 py-1">Position</th>
                    <th className="text-right px-2 py-1" title="Shadow / edge linearity / contrast evidence">Evidence S·L·C</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {detections.map((d) => (
                    <tr key={d.id} onClick={() => setSelectedDetId(d.id)} className={cn("cursor-pointer hover:bg-blue-50/60", d.id === selectedDetId && "bg-blue-50", d.status === "suppressed" && "text-slate-400")}>
                      <td className="px-2 py-1 font-bold">{d.code}</td>
                      <td className="px-2 py-1">
                        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shrink-0" style={{ background: classColor(d.className) }} />{classLabel(d.className)}</span>
                      </td>
                      <td className="px-2 py-1 text-right font-bold">{d.confidence.toFixed(1)}%</td>
                      <td className="px-2 py-1">
                        {d.status === "confirmed" ? (
                          <span className={cn("px-1 rounded border text-[10px] capitalize", SEVERITY_META[d.severity]?.badge)}>{d.severity}</span>
                        ) : (
                          <span className="text-[10px]" title={d.suppressionReasons.join(", ")}>{SUPPRESSION_LABELS[d.suppressionReasons[0]] ?? "suppressed"}</span>
                        )}
                      </td>
                      <td className="px-2 py-1">{d.location ? fmtPoint(d.location, 4) : "—"}</td>
                      <td className="px-2 py-1 text-right text-slate-500">
                        {[d.evidence?.shadow, d.evidence?.linearity, d.evidence?.contrast].map((v) => fmtNum(v, 2)).join(" · ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      <GeoreferenceDialog open={georefOpen} onClose={() => setGeorefOpen(false)} />
    </div>
  );
}
