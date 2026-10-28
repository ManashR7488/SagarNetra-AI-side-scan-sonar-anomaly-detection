import { ArrowDown, ArrowRight, ArrowUp, FlaskConical } from 'lucide-react';
import {
  CartesianGrid, Legend, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { cn } from '../../utils/cn';
import { DECISION_LABELS, METRICS, SUBSCORE_LABELS, fmtMetric, metricTrend } from '../../utils/noise';

const tip = { backgroundColor: '#fff', borderColor: '#e2e8f0', color: '#0f172a', fontSize: 10, padding: 6 };

function Section({ title, children, right }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-2.5 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold text-slate-800 uppercase tracking-wide">{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

function QualityHeader({ before, after }) {
  const tone = (v) => (v === undefined || v === null ? 'text-slate-400' : v >= 85 ? 'text-emerald-600' : v >= 65 ? 'text-amber-600' : 'text-red-600');
  return (
    <div className="flex items-center justify-around py-1">
      <div className="text-center">
        <div className="text-[10px] text-slate-500 font-medium">Raw data quality</div>
        <div className={cn('text-3xl font-extrabold', tone(before))}>{before ?? '—'}</div>
      </div>
      <ArrowRight className="w-5 h-5 text-slate-300" />
      <div className="text-center">
        <div className="text-[10px] text-slate-500 font-medium">After cleaning</div>
        <div className={cn('text-3xl font-extrabold', tone(after))}>{after ?? '—'}</div>
      </div>
    </div>
  );
}

function SubScores({ before = {}, after = {} }) {
  const keys = Object.keys({ ...before, ...after });
  return (
    <div className="space-y-1">
      {keys.map((k) => (
        <div key={k} className="grid grid-cols-[96px_1fr_52px] items-center gap-1.5 text-[10px]">
          <span className="text-slate-600 truncate">{SUBSCORE_LABELS[k] ?? k}</span>
          <div className="relative h-2 bg-slate-100 rounded">
            <div className="absolute inset-y-0 left-0 bg-slate-300 rounded" style={{ width: `${before[k] ?? 0}%` }} />
            <div className="absolute inset-y-0 left-0 bg-blue-500/80 rounded" style={{ width: `${after[k] ?? before[k] ?? 0}%`, height: '50%', top: '25%' }} />
          </div>
          <span className="font-mono text-right text-slate-700">{before[k] ?? '—'}→<b>{after[k] ?? '—'}</b></span>
        </div>
      ))}
      <div className="flex gap-3 text-[9px] text-slate-400 pt-0.5">
        <span className="flex items-center gap-1"><span className="w-2.5 h-1.5 bg-slate-300 rounded-sm" />raw</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-1.5 bg-blue-500 rounded-sm" />cleaned</span>
      </div>
    </div>
  );
}

function MetricTable({ before = {}, after = {} }) {
  return (
    <table className="w-full text-[10px]">
      <tbody className="divide-y divide-slate-100">
        {METRICS.map((m) => {
          const t = metricTrend(m, before[m.key], after[m.key]);
          const Arrow = t === 0 ? null : (after[m.key] > before[m.key] ? ArrowUp : ArrowDown);
          return (
            <tr key={m.key} title={m.hint}>
              <td className="py-1 text-slate-500">{m.label}</td>
              <td className="py-1 text-right font-mono text-slate-500">{fmtMetric(m, before[m.key])}</td>
              <td className="py-1 text-right font-mono font-bold w-20">
                <span className={cn('inline-flex items-center gap-0.5', t > 0 ? 'text-emerald-600' : t < 0 ? 'text-red-600' : 'text-slate-700')}>
                  {fmtMetric(m, after[m.key])}{Arrow && <Arrow className="w-2.5 h-2.5" />}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function AcrossChart({ before, after }) {
  const b = before?.series?.across_profile ?? [];
  const a = after?.series?.across_profile ?? [];
  if (!b.length) return null;
  const data = b.map((v, i) => ({ i, before: v, after: a[i] ?? null }));
  return (
    <div className="h-32">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 6, left: -24, bottom: 0 }}>
          <CartesianGrid stroke="#f1f5f9" />
          <XAxis dataKey="i" tick={false} axisLine={{ stroke: '#cbd5e1' }} />
          <YAxis tick={{ fontSize: 9, fill: '#94a3b8' }} />
          <Tooltip contentStyle={tip} labelFormatter={(i) => (i < (before?.series?.nadir_bin ?? 128) ? 'port' : 'starboard')} />
          {before?.series?.nadir_bin !== undefined && <ReferenceLine x={Math.round(before.series.nadir_bin)} stroke="#94a3b8" strokeDasharray="3 3" />}
          <Line dataKey="before" name="raw" stroke="#94a3b8" dot={false} strokeWidth={1.5} isAnimationActive={false} />
          <Line dataKey="after" name="cleaned" stroke="#2563eb" dot={false} strokeWidth={1.5} isAnimationActive={false} connectNulls />
          <Legend wrapperStyle={{ fontSize: 9 }} height={14} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function PingChart({ before, after }) {
  const bp = before?.series?.ping_level_port ?? [];
  if (!bp.length) return null;
  const bs = before.series.ping_level_stbd ?? [];
  const ap = after?.series?.ping_level_port ?? [];
  const as = after?.series?.ping_level_stbd ?? [];
  const n = Math.max(bp.length, ap.length);
  const pick = (arr, i) => (arr.length ? arr[Math.min(arr.length - 1, Math.round((i / Math.max(n - 1, 1)) * (arr.length - 1)))] : null);
  const data = Array.from({ length: n }, (_, i) => ({ i, rawPort: pick(bp, i), rawStbd: pick(bs, i), port: pick(ap, i), stbd: pick(as, i) }));
  return (
    <div className="h-32">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 6, left: -24, bottom: 0 }}>
          <CartesianGrid stroke="#f1f5f9" />
          <XAxis dataKey="i" tick={false} axisLine={{ stroke: '#cbd5e1' }} />
          <YAxis tick={{ fontSize: 9, fill: '#94a3b8' }} />
          <Tooltip contentStyle={tip} labelFormatter={() => 'along-track'} />
          <Line dataKey="rawPort" name="raw port" stroke="#fca5a5" dot={false} strokeWidth={1} isAnimationActive={false} />
          <Line dataKey="rawStbd" name="raw stbd" stroke="#86efac" dot={false} strokeWidth={1} isAnimationActive={false} />
          <Line dataKey="port" name="port" stroke="#dc2626" dot={false} strokeWidth={1.5} isAnimationActive={false} />
          <Line dataKey="stbd" name="stbd" stroke="#16a34a" dot={false} strokeWidth={1.5} isAnimationActive={false} />
          <Legend wrapperStyle={{ fontSize: 9 }} height={14} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

const FLAG_COLORS = { pitch: '#f97316', roll: '#a855f7', yaw_rate: '#0ea5e9', heave_rate: '#14b8a6', dropouts: '#ef4444', time_gaps: '#64748b' };

function MotionChart({ motion }) {
  const s = motion?.series;
  if (!s?.ping?.length) return null;
  const data = s.ping.map((p, i) => ({ p, pitch: s.pitch_deg[i], roll: s.roll_deg[i], heading: s.heading_dev_deg[i], heave: s.heave_m[i] * 10 }));
  const ranges = Object.entries(motion.flagged_ranges ?? {}).flatMap(([k, rs]) => rs.map(([a, b]) => ({ k, a, b })));
  return (
    <div className="space-y-1">
      <div className="h-36">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 6, left: -24, bottom: 0 }}>
            <CartesianGrid stroke="#f1f5f9" />
            <XAxis dataKey="p" type="number" domain={[0, motion.pings]} tick={{ fontSize: 9, fill: '#94a3b8' }} />
            <YAxis tick={{ fontSize: 9, fill: '#94a3b8' }} />
            <Tooltip contentStyle={tip} labelFormatter={(p) => `ping ${p}`} />
            {ranges.slice(0, 120).map((r, i) => (
              <ReferenceArea key={i} x1={r.a} x2={Math.max(r.b, r.a + 1)} fill={FLAG_COLORS[r.k] ?? '#ef4444'} fillOpacity={0.18} stroke="none" />
            ))}
            <Line dataKey="pitch" name="pitch °" stroke="#f97316" dot={false} strokeWidth={1} isAnimationActive={false} />
            <Line dataKey="roll" name="roll °" stroke="#a855f7" dot={false} strokeWidth={1} isAnimationActive={false} />
            <Line dataKey="heading" name="heading dev °" stroke="#0ea5e9" dot={false} strokeWidth={1} isAnimationActive={false} />
            <Line dataKey="heave" name="heave ×10 m" stroke="#14b8a6" dot={false} strokeWidth={1} isAnimationActive={false} />
            <Legend wrapperStyle={{ fontSize: 9 }} height={14} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[9px] text-slate-500">
        {Object.entries(motion.flagged_ranges ?? {}).map(([k, rs]) => (
          <span key={k} className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: FLAG_COLORS[k] ?? '#ef4444', opacity: 0.5 }} />
            {k.replace('_', ' ')}: {rs.reduce((n, [a, b]) => n + (b - a), 0)} pings
          </span>
        ))}
      </div>
    </div>
  );
}

// benchmark step -> the AI-profile setting that switches it on
const STEP_SETTING = {
  dropouts: 'repair_dropouts', motion: 'motion', stripes: 'destripe', ping_gain: 'gain_along', range_gain: 'gain_across',
  water_column: 'mask_water_column', ground_range: 'slant_correct', speckle: 'despeckle', resolution: 'normalize_resolution',
};

function Evidence({ benchmark }) {
  const steps = benchmark?.steps ?? [];
  if (!steps.length) {
    return <p className="text-[10px] text-slate-500">No benchmark yet: the AI input keeps only dropout repair and motion compensation. Run <code>tools/benchmark_cleaning.py</code> to measure every step.</p>;
  }
  const used = (k) => {
    const v = benchmark.ai?.[STEP_SETTING[k]];
    return Boolean(v) && v !== 'none';
  };
  const delta = (d) => (d ? `${d.f1 > 0 ? '+' : ''}${d.f1.toFixed(3)}` : '—');
  const tone = (d) => (!d ? 'text-slate-400' : d.f1 > 0.005 ? 'text-emerald-600' : d.f1 < -0.005 ? 'text-red-500' : 'text-slate-500');
  return (
    <div className="space-y-1.5">
      <p className="text-[10px] text-slate-500 leading-snug">
        {benchmark.summary} Change in detection F1 against the same pipeline with every cleaning step off (hover a row for recall and false alarms).
      </p>
      <table className="w-full text-[10px]">
        <thead className="text-slate-400">
          <tr><th className="text-left font-medium">Step</th><th className="text-right font-medium">ΔF1 synthetic</th><th className="text-right font-medium">ΔF1 real</th><th className="text-right font-medium">AI input</th></tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {steps.map((s) => {
            // 'combination': the AI-input steps on every file; 'auto': as Auto runs them (only where the noise is measured)
            const together = s.step === 'combination' || s.step === 'auto';
            const label = s.step === 'combination' ? 'Used steps, always on' : s.step === 'auto' ? 'Auto, as it runs' : DECISION_LABELS[s.step] ?? s.step;
            return (
              <tr key={s.step} title={s.summary} className={together ? 'font-semibold' : undefined}>
                <td className="py-0.5 text-slate-600">{label}</td>
                <td className={cn('py-0.5 text-right font-mono', tone(s.delta?.synthetic))}>{delta(s.delta?.synthetic)}</td>
                <td className={cn('py-0.5 text-right font-mono', tone(s.delta?.ai4shipwrecks))}>{delta(s.delta?.ai4shipwrecks)}</td>
                <td className="py-0.5 text-right">{together ? (s.helps ? '✓' : '✗') : used(s.step) ? '✓' : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function NoiseReport({ result, showEvidence }) {
  if (!result) return null;
  const r = result.report ?? {};
  return (
    <div className="space-y-2">
      <Section title="Noise report">
        <QualityHeader before={r.quality_before} after={r.quality_after} />
        <SubScores before={r.subscores_before} after={r.subscores_after} />
      </Section>
      <Section title="Measurements" right={<span className="text-[9px] text-slate-400">raw → cleaned</span>}>
        <MetricTable before={r.before} after={r.after} />
      </Section>
      <Section title="Brightness across the swath">
        <AcrossChart before={r.before} after={r.after} />
        <p className="text-[9px] text-slate-400">Seabed brightness vs range (port | starboard). Flat = no gain error.</p>
      </Section>
      <Section title="Brightness along the track">
        <PingChart before={r.before} after={r.after} />
        <p className="text-[9px] text-slate-400">Per-ping level of each side: steps, jitter and roll show here.</p>
      </Section>
      {r.motion?.series && (
        <Section title="Vehicle motion (XTF)" right={<span className="text-[9px] text-slate-400">{r.pings?.motion_flagged ?? 0} pings over limits</span>}>
          <MotionChart motion={r.motion} />
        </Section>
      )}
      {showEvidence && (
        <Section title="Why the AI input uses these steps" right={<FlaskConical className="w-3.5 h-3.5 text-blue-500" />}>
          <Evidence benchmark={result.benchmark} />
        </Section>
      )}
    </div>
  );
}
