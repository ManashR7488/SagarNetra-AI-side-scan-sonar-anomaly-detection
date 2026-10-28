import { useState } from 'react';
import { Activity, Loader2, Play } from 'lucide-react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { cn } from '../../utils/cn';
import { DISTURBANCE_META, PIPELINE_META } from '../../utils/noise';

const tip = { backgroundColor: '#fff', borderColor: '#e2e8f0', color: '#0f172a', fontSize: 10, padding: 6 };
const PIPES = ['raw', 'auto', 'full'];

function Thumb({ src, boxes = [], size, label }) {
  return (
    <div className="space-y-0.5">
      <div className="relative bg-slate-900 rounded overflow-hidden aspect-square">
        {src && <img src={src} alt="" className="absolute inset-0 w-full h-full object-contain" draggable={false} />}
        {src && size && <ThumbBoxes boxes={boxes} size={size} />}
      </div>
      <div className="text-[9px] text-slate-500 text-center truncate">{label}</div>
    </div>
  );
}

/** Boxes are in thumbnail pixels (the server scales them); fitted exactly like the object-contain image. */
function ThumbBoxes({ boxes, size }) {
  return (
    <svg className="absolute inset-0 w-full h-full" viewBox={`0 0 ${size[0]} ${size[1]}`} preserveAspectRatio="xMidYMid meet">
      {boxes.map((b, i) => (
        <rect key={i} x={b.bbox[0]} y={b.bbox[1]} width={b.bbox[2] - b.bbox[0]} height={b.bbox[3] - b.bbox[1]}
          fill="none" stroke="#22d3ee" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

function DisturbanceCard({ kind, result }) {
  const [level, setLevel] = useState(result.series.length);
  const meta = DISTURBANCE_META[kind];
  const base = result.baseline;
  // each pipeline is compared with its own detections on the undisturbed region (older results: the raw ones)
  const own = (p) => base.pipelines?.[p] ?? base;
  const anyBase = PIPES.some((p) => own(p).detections > 0);
  const data = [
    { level: 0, label: 'clean', raw: 100, auto: 100, full: 100, rawConf: own('raw').mean_confidence, autoConf: own('auto').mean_confidence, fullConf: own('full').mean_confidence },
    ...result.series.map((s) => ({
      level: s.level, label: s.label,
      raw: s.results.raw.retention === null ? null : s.results.raw.retention * 100,
      auto: s.results.auto.retention === null ? null : s.results.auto.retention * 100,
      full: s.results.full.retention === null ? null : s.results.full.retention * 100,
      rawConf: s.results.raw.mean_confidence, autoConf: s.results.auto.mean_confidence, fullConf: s.results.full.mean_confidence,
    })),
  ];
  const sel = result.series.find((s) => s.level === level) ?? result.series[result.series.length - 1];
  const size = [result.region.width * result.thumb_scale, result.region.height * result.thumb_scale];
  const last = result.series[result.series.length - 1];
  const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-2.5 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-xs font-bold text-slate-800">{meta.label}</div>
          <div className="text-[10px] text-slate-500">{meta.hint}</div>
        </div>
        <div className="text-right text-[10px] text-slate-500 shrink-0" title="Detections of each pipeline on the undisturbed region">
          undisturbed: {PIPES.map((p, i) => (
            <span key={p}>{i ? ' · ' : ''}{PIPELINE_META[p].short ?? PIPELINE_META[p].label} <b>{own(p).detections}</b></span>
          ))}
        </div>
      </div>
      {!anyBase ? (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
          No confirmed detection in the tested region: there is nothing to keep. Pick a region with an object (stage 2 → select a detection → “around the selected detection”).
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="h-36">
              <div className="text-[9px] text-slate-400 font-medium">Detections kept (%)</div>
              <ResponsiveContainer width="100%" height="92%">
                <LineChart data={data} margin={{ top: 4, right: 6, left: -26, bottom: 0 }}>
                  <CartesianGrid stroke="#f1f5f9" />
                  <XAxis dataKey="level" tick={{ fontSize: 9, fill: '#94a3b8' }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#94a3b8' }} />
                  <Tooltip contentStyle={tip} labelFormatter={(l) => data.find((d) => d.level === l)?.label} formatter={(v) => `${Math.round(v)}%`} />
                  {PIPES.map((p) => <Line key={p} dataKey={p} name={PIPELINE_META[p].label} stroke={PIPELINE_META[p].color} strokeWidth={p === 'auto' ? 2.5 : 1.5} dot={{ r: 2 }} isAnimationActive={false} connectNulls />)}
                  <Legend wrapperStyle={{ fontSize: 9 }} height={14} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="h-36">
              <div className="text-[9px] text-slate-400 font-medium">Confidence of kept detections (%)</div>
              <ResponsiveContainer width="100%" height="92%">
                <LineChart data={data} margin={{ top: 4, right: 6, left: -26, bottom: 0 }}>
                  <CartesianGrid stroke="#f1f5f9" />
                  <XAxis dataKey="level" tick={{ fontSize: 9, fill: '#94a3b8' }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: '#94a3b8' }} />
                  <Tooltip contentStyle={tip} labelFormatter={(l) => data.find((d) => d.level === l)?.label} />
                  {PIPES.map((p) => <Line key={p} dataKey={`${p}Conf`} name={PIPELINE_META[p].label} stroke={PIPELINE_META[p].color} strokeWidth={p === 'auto' ? 2.5 : 1.5} dot={{ r: 2 }} isAnimationActive={false} connectNulls />)}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-1.5 text-[10px]">
            {PIPES.map((p) => (
              <div key={p} className="rounded border border-slate-200 p-1.5" style={{ borderTopColor: PIPELINE_META[p].color, borderTopWidth: 3 }}>
                <div className="font-semibold text-slate-700">{PIPELINE_META[p].label}</div>
                <div className="text-slate-500">at “{last.label}”: kept <b className="text-slate-800">{pct(last.results[p].retention)}</b> of its {own(p).detections}, {last.results[p].new_false_alarms} new detection{last.results[p].new_false_alarms === 1 ? '' : 's'}</div>
                {p !== 'raw' && <div className="text-[9px] text-slate-400 truncate" title={(last.cleaning_steps[p] ?? []).join(', ')}>steps: {(last.cleaning_steps[p] ?? []).join(', ') || 'none needed'}</div>}
              </div>
            ))}
          </div>
        </>
      )}
      <div className="space-y-1">
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-[10px] text-slate-500 mr-1">Level:</span>
          {result.series.map((s) => (
            <button key={s.level} type="button" onClick={() => setLevel(s.level)} className={cn('px-1.5 py-0.5 rounded text-[10px] border cursor-pointer', s.level === sel.level ? 'bg-blue-600 text-white border-blue-600' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50')}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          <Thumb src={base.thumb} boxes={base.boxes} size={size} label="undisturbed" />
          <Thumb src={sel.thumbs.disturbed} boxes={sel.boxes.raw} size={size} label={`${sel.label} · no cleaning`} />
          <Thumb src={sel.thumbs.auto} boxes={sel.boxes.auto} size={size} label="auto (AI profile)" />
          <Thumb src={sel.thumbs.full} boxes={sel.boxes.full} size={size} label="full visual cleaning" />
        </div>
      </div>
    </div>
  );
}

export default function StressPanel({ opts, onOpts, onRun, running, results, canUseSelected, geometryChanged }) {
  const toggle = (k) => onOpts({ disturbances: opts.disturbances.includes(k) ? opts.disturbances.filter((x) => x !== k) : [...opts.disturbances, k] });
  const done = Object.keys(results);
  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      <div className="bg-white border border-slate-200 rounded-lg p-3 flex flex-wrap items-end gap-4 shrink-0">
        <div className="space-y-1">
          <div className="text-[11px] font-semibold text-slate-700">Disturbances</div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(DISTURBANCE_META).map(([k, m]) => (
              <label key={k} title={m.hint} className={cn('flex items-center gap-1.5 px-2 py-1 rounded border text-[11px] cursor-pointer', opts.disturbances.includes(k) ? 'bg-blue-50 border-blue-300 text-blue-800' : 'bg-slate-50 border-slate-200 text-slate-600')}>
                <input type="checkbox" checked={opts.disturbances.includes(k)} onChange={() => toggle(k)} className="accent-blue-600" />{m.label}
              </label>
            ))}
          </div>
        </div>
        <div className="space-y-1">
          <div className="text-[11px] font-semibold text-slate-700">Levels</div>
          <select value={opts.levels} onChange={(e) => onOpts({ levels: Number(e.target.value) })} className="bg-slate-50 border border-slate-300 rounded px-2 py-1 text-[11px]">
            {[2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} increasing levels</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <div className="text-[11px] font-semibold text-slate-700">Region</div>
          <select value={opts.region} onChange={(e) => onOpts({ region: e.target.value })} className="bg-slate-50 border border-slate-300 rounded px-2 py-1 text-[11px]">
            <option value="auto">Around the strongest detection</option>
            <option value="selected" disabled={!canUseSelected}>Around the selected detection (stage 2)</option>
          </select>
          {opts.region === 'selected' && geometryChanged && <div className="text-[9px] text-amber-600">AI cleaning changed the geometry: the strongest detection is used</div>}
        </div>
        <button type="button" onClick={onRun} disabled={Boolean(running)} className="ml-auto flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-xs font-semibold cursor-pointer disabled:opacity-60">
          {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          {running ? `Testing ${DISTURBANCE_META[running.current]?.label.toLowerCase()} (${running.done + 1}/${running.total})…` : 'Run stress test'}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {done.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-slate-500 gap-2 p-6">
            <Activity className="w-8 h-8 text-slate-300" />
            <p className="text-xs max-w-md">Each disturbance is injected into a region of this scan at increasing strength. The detector then runs three ways:
              <b> without cleaning</b>, with <b>Auto (the AI profile production uses)</b> and with <b>full visual cleaning</b>.
              Each pipeline is compared with its own detections on the undisturbed region: the curves show how many survive
              each level and how confident they stay, and new detections are likely false alarms.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 2xl:grid-cols-2 gap-3">
            {done.map((k) => <DisturbanceCard key={k} kind={k} result={results[k]} />)}
          </div>
        )}
      </div>
    </div>
  );
}
