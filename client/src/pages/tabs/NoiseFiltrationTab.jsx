import { useEffect } from "react";
import { Filter, Sliders, RefreshCw, Sparkles, Upload, Loader2, ImageOff, ArrowDown, ArrowUp } from "lucide-react";
import { SAMPLE_SCANS } from "../../data/sonarData";
import { useFilterStore } from "../../store/useFilterStore";
import { cn } from "../../utils/cn";

const METHODS = [
  { id: "lee", name: "Lee (adaptive)" },
  { id: "frost", name: "Frost (exponential)" },
  { id: "kuan", name: "Kuan (MMSE)" },
  { id: "median", name: "Median" },
  { id: "none", name: "No despeckle" },
];

function Slider({ label, value, display, min = 0, max = 100, step = 1, onChange, disabled, hint }) {
  return (
    <div className={cn("space-y-1", disabled && "opacity-40")}>
      <div className="flex justify-between text-xs">
        <span className="text-slate-600 font-medium">{label}</span>
        <span className="font-mono font-bold text-blue-600">{display ?? value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600 disabled:cursor-not-allowed" />
      {hint && <p className="text-[10px] text-slate-400">{hint}</p>}
    </div>
  );
}

/** before -> after with a coloured arrow; `lowerIsBetter` decides green vs red. */
function Metric({ label, before, after, lowerIsBetter, neutral = false, digits = 3, hint }) {
  const has = before !== undefined && after !== undefined;
  const better = has && (lowerIsBetter ? after < before : after > before);
  const tone = neutral ? "text-slate-800" : better ? "text-emerald-600" : "text-red-600";
  const Arrow = has && after < before ? ArrowDown : ArrowUp;
  return (
    <div className="flex justify-between items-center" title={hint}>
      <span className="text-slate-500">{label}:</span>
      {has ? (
        <span className="font-bold flex items-center gap-1">
          <span className="text-slate-500 font-normal">{before.toFixed(digits)}</span>→
          <span className={tone}>{after.toFixed(digits)}</span>
          {before !== after && <Arrow className={cn("w-3 h-3", tone)} />}
        </span>
      ) : <span className="text-slate-400">—</span>}
    </div>
  );
}

export default function NoiseFiltrationTab() {
  const source = useFilterStore((s) => s.source);
  const params = useFilterStore((s) => s.params);
  const result = useFilterStore((s) => s.result);
  const loading = useFilterStore((s) => s.loading);
  const { setParams, resetParams, setSample, setFile, run } = useFilterStore.getState();

  // Show a result straight away for the first visit.
  useEffect(() => {
    if (!useFilterStore.getState().result) run();
  }, [run]);

  const originalUrl = result?.images?.original ?? (source.kind === "sample" ? source.sample.image : source.url);
  const before = result?.quality_before;
  const after = result?.quality_after;

  return (
    <div className="flex flex-col h-full bg-slate-100 p-3 gap-3 overflow-hidden text-slate-900 font-sans">
      <div className="bg-white border border-slate-200 rounded-lg p-3 flex items-center justify-between shrink-0 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-200">
            <Filter className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-900">Acoustic Speckle Noise & Shadow Filtration Pipeline</h2>
            <p className="text-[11px] text-slate-500 font-mono">Server-side despeckling, ping-dropout repair & CLAHE contrast equalisation (AI service)</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-slate-500">Sonar image:</span>
          <select
            value={source.kind === "sample" ? source.sample.id : ""}
            onChange={(e) => e.target.value && setSample(e.target.value)}
            className="bg-slate-50 border border-slate-300 text-slate-800 rounded-md px-2.5 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer max-w-[260px]"
          >
            {source.kind === "file" && <option value="">Uploaded: {source.file.name}</option>}
            {SAMPLE_SCANS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <label className="flex items-center gap-1.5 px-3 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium rounded-md border border-slate-300 cursor-pointer">
            <Upload className="w-3.5 h-3.5 text-blue-600" />Upload
            <input type="file" accept="image/*,.tif,.tiff,.xtf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) setFile(f); e.target.value = ""; }} />
          </label>
          <button type="button" onClick={resetParams} className="flex items-center gap-1.5 px-3 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium rounded-md border border-slate-300 transition-colors cursor-pointer">
            <RefreshCw className="w-3.5 h-3.5" />Reset
          </button>
        </div>
      </div>

      <div className="flex-1 grid grid-cols-12 gap-3 min-h-0">
        <div className="col-span-4 bg-white border border-slate-200 rounded-lg p-4 flex flex-col justify-between shadow-xs overflow-y-auto">
          <div className="space-y-4">
            <div className="flex items-center gap-2 pb-2 border-b border-slate-100">
              <Sliders className="w-4 h-4 text-blue-600" />
              <span className="text-xs font-bold text-slate-800 uppercase tracking-wide">Filter Parameters</span>
            </div>

            <div className="space-y-1.5">
              <span className="text-xs font-semibold text-slate-700">Despeckling algorithm</span>
              <div className="grid grid-cols-2 gap-1.5">
                {METHODS.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setParams({ denoise: m.id })}
                    className={cn("px-2.5 py-1.5 rounded text-[11px] font-medium border text-left transition-all cursor-pointer",
                      params.denoise === m.id ? "bg-blue-50 border-blue-300 text-blue-700 font-bold" : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100")}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
            </div>

            <Slider label="Despeckle strength" value={params.denoiseStrength} display={`${params.denoiseStrength}% · ${3 + 2 * Math.round((params.denoiseStrength / 100) * 3)} px window`}
              onChange={(v) => setParams({ denoiseStrength: v })} disabled={params.denoise === "none"} />

            <Slider label="Acoustic shadow contrast (gamma)" value={params.shadowGamma} display={`γ ${params.shadowGamma.toFixed(2)}`} min={0.5} max={2.5} step={0.05}
              onChange={(v) => setParams({ shadowGamma: v })} hint=">1 darkens low returns so acoustic shadows stand out" />

            <div className="space-y-2">
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer">
                <input type="checkbox" checked={params.clahe} onChange={(e) => setParams({ clahe: e.target.checked })} className="accent-blue-600" />
                CLAHE contrast equalisation
              </label>
              <Slider label="CLAHE gain" value={params.claheStrength} display={`${params.claheStrength}% · clip ${(1 + (params.claheStrength / 100) * 3).toFixed(1)}`}
                onChange={(v) => setParams({ claheStrength: v })} disabled={!params.clahe} />
            </div>

            <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer">
              <input type="checkbox" checked={params.repairDropouts} onChange={(e) => setParams({ repairDropouts: e.target.checked })} className="accent-blue-600" />
              Repair ping dropouts (heave / pitch / roll)
            </label>

            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-1.5 font-mono">
              <Metric label="Speckle index" before={before?.speckle_index} after={after?.speckle_index} lowerIsBetter
                hint="Mean local std / mean. Lower = smoother. Contrast enhancement (CLAHE, gamma) raises it." />
              <Metric label="Equivalent looks (ENL)" before={before?.equivalent_number_of_looks} after={after?.equivalent_number_of_looks} digits={1}
                hint="Estimated from the most homogeneous areas. Higher = less speckle." />
              <Metric label="Mean intensity" before={before?.mean_intensity} after={after?.mean_intensity} digits={1} neutral />
              <div className="flex justify-between">
                <span className="text-slate-500">Dropout pings:</span>
                <span className="font-bold text-slate-800">{result ? `${result.dropout_rows_detected} found · ${result.dropout_rows_repaired} repaired` : "—"}</span>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={run}
            disabled={loading}
            className="w-full mt-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-md font-semibold text-xs transition-all shadow-xs flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            <span>{loading ? "Running filter pipeline…" : "Apply Noise Filters"}</span>
          </button>
        </div>

        <div className="col-span-8 grid grid-cols-2 gap-3 min-h-0">
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden flex flex-col shadow-xs min-h-0">
            <div className="bg-slate-50 border-b border-slate-200 px-3 py-1.5 flex justify-between items-center text-xs">
              <span className="font-mono font-bold text-slate-800">BEFORE: RAW SONAR (GRAYSCALE)</span>
              {result && <span className="text-[10px] font-mono text-slate-500">{result.source.width} × {result.source.height} px</span>}
            </div>
            <div className="flex-1 bg-slate-950 p-2 flex items-center justify-center overflow-hidden min-h-0">
              {originalUrl ? <img src={originalUrl} alt="Raw sonar" className="max-w-full max-h-full object-contain grayscale" /> : <ImageOff className="w-8 h-8 text-slate-600" />}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden flex flex-col shadow-xs min-h-0">
            <div className="bg-slate-50 border-b border-slate-200 px-3 py-1.5 flex justify-between items-center text-xs">
              <span className="font-mono font-bold text-blue-600">AFTER: FILTERED</span>
              {result && (
                <span className="text-[10px] font-mono text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded font-bold uppercase">
                  {result.params.denoise}{result.params.clahe ? " + CLAHE" : ""}{result.params.shadow_gamma !== 1 ? ` + γ${result.params.shadow_gamma}` : ""}
                </span>
              )}
            </div>
            <div className="flex-1 bg-slate-950 p-2 flex items-center justify-center overflow-hidden min-h-0 relative">
              {result?.images?.filtered ? (
                <img src={result.images.filtered} alt="Filtered sonar" className="max-w-full max-h-full object-contain" />
              ) : (
                <span className="text-xs font-mono text-slate-500">Press “Apply Noise Filters”</span>
              )}
              {loading && <div className="absolute inset-0 bg-slate-950/50 flex items-center justify-center"><Loader2 className="w-8 h-8 text-white animate-spin" /></div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
