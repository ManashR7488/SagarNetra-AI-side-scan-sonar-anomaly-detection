import { CheckCircle2, MinusCircle } from 'lucide-react';
import { cn } from '../../utils/cn';
import { fmtMs } from '../../utils/format';
import { STEP_META } from '../../utils/noise';

/** One line saying what the step did, from its report. */
function stepSummary(step) {
  const i = step.info ?? {};
  if (!step.applied) return i.reason ?? 'not needed';
  switch (step.id) {
    case 'raw':
      return i.water_column ? `water column at col ${Math.round(i.water_column.nadir_column)}` : 'no water column (crop / ground range)';
    case 'dropouts': {
      const parts = [];
      if (i.blank) parts.push(`${i.blank} lost`);
      if (i.partial) parts.push(`${i.partial} partial`);
      if (i.duplicate) parts.push(`${i.duplicate} repeated`);
      return `${parts.join(', ') || 'bad'} pings → ${i.repaired} repaired`;
    }
    case 'motion':
      return `yaw ${i.yaw_deg?.rms ?? '—'}° rms · speed ±${Math.round((i.speed_mps?.cv ?? 0) * 100)}% · up to ${i.max_offset_m ?? '—'} m corrected`;
    case 'gain': {
      const parts = [];
      if (i.stripes?.pixels) parts.push(`${i.stripes.bursts} interference bursts`);
      if (i.ping_gain?.gain_steps?.length) parts.push(`${i.ping_gain.gain_steps.length} gain step${i.ping_gain.gain_steps.length > 1 ? 's' : ''}`);
      if (i.ping_gain?.applied) parts.push('ping gain');
      if (i.range_gain?.applied) parts.push(`range gain ×${i.range_gain.min_gain}–${i.range_gain.max_gain}`);
      return parts.join(' · ') || 'levelled';
    }
    case 'seabed': {
      const parts = [];
      if (i.water_column?.applied) parts.push('water column masked');
      if (i.surface_echo?.applied) parts.push('surface echo removed');
      if (i.ground_range?.applied) parts.push('ground range');
      return parts.join(' · ') || 'checked';
    }
    case 'speckle':
      return `${i.method} filter, strength ${i.strength}`;
    case 'resolution':
      return `${i.from_m_per_px?.[0]} → ${i.to_m_per_px} m/px`;
    case 'display':
      return `shadow γ ${i.shadow_gamma}${i.clahe ? ' · local contrast' : ''}`;
    default:
      return '';
  }
}

export default function StepCards({ steps = [], selected, onSelect }) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {steps.map((s, idx) => {
        const meta = STEP_META[s.id] ?? { label: s.name };
        const clickable = Boolean(s.image);
        return (
          <button
            key={s.id}
            type="button"
            disabled={!clickable}
            onClick={() => clickable && onSelect(s.id)}
            title={s.notes?.join('\n') || stepSummary(s)}
            className={cn(
              'shrink-0 w-40 text-left rounded-lg border bg-white overflow-hidden transition-all',
              clickable ? 'cursor-pointer hover:border-blue-300' : 'cursor-default opacity-60',
              selected === s.id ? 'border-blue-500 ring-2 ring-blue-200' : 'border-slate-200',
            )}
          >
            <div className="h-16 bg-slate-900 relative overflow-hidden">
              {s.image ? (
                <img src={s.image} alt="" className="w-full h-full object-cover object-center" draggable={false} />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-[10px] font-mono text-slate-500">no change</div>
              )}
              <span className="absolute top-1 left-1 text-[9px] font-mono font-bold px-1 rounded bg-slate-900/80 text-slate-200">{idx}</span>
            </div>
            <div className="p-1.5 space-y-0.5">
              <div className="flex items-center gap-1 text-[11px] font-semibold text-slate-800">
                {s.applied ? <CheckCircle2 className="w-3 h-3 text-emerald-600 shrink-0" /> : <MinusCircle className="w-3 h-3 text-slate-400 shrink-0" />}
                <span className="truncate">{meta.label}</span>
              </div>
              <div className="text-[10px] text-slate-500 leading-tight line-clamp-2 min-h-[24px]">{stepSummary(s)}</div>
              <div className="text-[9px] font-mono text-slate-400">{s.applied || s.id === 'raw' ? fmtMs(s.ms) : 'skipped'}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
