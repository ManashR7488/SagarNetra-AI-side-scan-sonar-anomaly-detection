import { Check, RotateCcw, ShieldAlert, X } from 'lucide-react';
import { classColor, classLabel, SUPPRESSION_LABELS } from '../../utils/classes';
import { cn } from '../../utils/cn';
import { NATURAL_META, QUALITY_FLAG_LABELS, liveStatus } from '../../utils/noise';

function ConfidenceBar({ value, threshold }) {
  return (
    <div className="relative h-1.5 bg-slate-100 rounded">
      <div className={cn('absolute inset-y-0 left-0 rounded', value >= threshold ? 'bg-emerald-500' : 'bg-slate-400')} style={{ width: `${value}%` }} />
      <div className="absolute -top-0.5 -bottom-0.5 w-px bg-slate-700" style={{ left: `${threshold}%` }} title={`threshold ${threshold}`} />
    </div>
  );
}

function Detail({ d, live, onReview }) {
  const nat = d.natural?.label ? NATURAL_META[d.natural.label] : null;
  const q = d.quality;
  return (
    <div className="mt-1.5 pt-1.5 border-t border-slate-100 space-y-1.5 text-[10px]">
      {d.natural?.reasons?.length > 0 && (
        <div>
          <div className="text-slate-400 font-medium mb-0.5">{live.aiStatus === 'confirmed' ? 'Why the AI keeps it' : 'Why the AI rejects it'}</div>
          <ul className="space-y-0.5">
            {d.natural.reasons.map((r) => (
              <li key={r} className="flex gap-1 text-slate-700"><span className={live.aiStatus === 'confirmed' ? 'text-emerald-600' : 'text-amber-600'}>•</span>{r}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-slate-600">
        {d.natural?.pManMade !== undefined && d.natural?.pManMade !== null && <span>P(man-made) <b>{Math.round(d.natural.pManMade * 100)}%</b></span>}
        {nat && <span>Looks like <b>{nat.short.toLowerCase()}</b></span>}
        <span>Shadow {d.shadow?.found ? <b>{(d.shadow.lengthRatio ?? 0).toFixed(1)}× its width</b> : <b>none</b>}</span>
        {d.evidence?.contrast !== undefined && <span>Contrast <b>{d.evidence.contrast.toFixed(2)}</b></span>}
        {d.evidence?.linearity !== undefined && <span>Straight edges <b>{d.evidence.linearity.toFixed(2)}</b></span>}
        {d.dimensions?.heightM !== undefined && d.dimensions?.heightM !== null && <span>Height <b>{d.dimensions.heightM} m</b></span>}
      </div>
      {q && (
        <div className="flex flex-wrap items-center gap-1">
          <span className={cn('px-1 rounded border font-mono', q.score >= 70 ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-amber-50 border-amber-200 text-amber-700')}>data quality {q.score}</span>
          {q.flags?.map((f) => <span key={f} className="px-1 rounded border bg-amber-50 border-amber-200 text-amber-700">{QUALITY_FLAG_LABELS[f] ?? f}</span>)}
        </div>
      )}
      {live.reasons.length > 0 && (
        <div className="text-slate-500">Status reasons: {live.reasons.map((r) => SUPPRESSION_LABELS[r] ?? r).join(', ')}</div>
      )}
      <div className="flex gap-1 pt-0.5">
        <button type="button" onClick={() => onReview(d.id, 'confirm')} className={cn('flex-1 flex items-center justify-center gap-1 py-1 rounded border font-semibold cursor-pointer', d.review?.status === 'verified' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white border-emerald-300 text-emerald-700 hover:bg-emerald-50')}>
          <Check className="w-3 h-3" />Real object
        </button>
        <button type="button" onClick={() => onReview(d.id, 'reject')} className={cn('flex-1 flex items-center justify-center gap-1 py-1 rounded border font-semibold cursor-pointer', d.review?.status === 'false_positive' ? 'bg-red-600 text-white border-red-600' : 'bg-white border-red-300 text-red-700 hover:bg-red-50')}>
          <X className="w-3 h-3" />False alarm
        </button>
        {d.review?.status && d.review.status !== 'unreviewed' && (
          <button type="button" onClick={() => onReview(d.id, 'clear')} className="px-1.5 rounded border border-slate-300 text-slate-500 hover:bg-slate-50 cursor-pointer" title="Back to the AI's decision"><RotateCcw className="w-3 h-3" /></button>
        )}
      </div>
    </div>
  );
}

export default function CandidateList({ detections = [], threshold, selectedId, onSelect, onReview, filter }) {
  const rows = detections.map((d) => ({ d, live: liveStatus(d, threshold) }))
    .filter(({ live }) => filter === 'all' || (filter === 'kept' ? live.status === 'confirmed' : live.status !== 'confirmed'))
    .sort((a, b) => b.d.confidence - a.d.confidence);
  if (!rows.length) {
    return <div className="text-[11px] text-slate-400 text-center py-6">No candidates here</div>;
  }
  return (
    <div className="space-y-1.5">
      {rows.map(({ d, live }) => {
        const nat = d.natural?.label && live.status !== 'confirmed' ? NATURAL_META[d.natural.label] : null;
        const sel = d.id === selectedId;
        return (
          <div key={d.id} onClick={() => onSelect(d.id)} className={cn('rounded-md border p-2 cursor-pointer transition-colors', sel ? 'border-blue-400 bg-blue-50/40' : 'border-slate-200 bg-white hover:border-slate-300')}>
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="font-mono font-bold text-slate-800">{d.code}</span>
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: classColor(d.className) }} />
              <span className="truncate text-slate-700">{classLabel(d.className)}</span>
              <span className="ml-auto font-mono font-bold text-slate-900">{d.confidence.toFixed(0)}%</span>
            </div>
            <div className="mt-1"><ConfidenceBar value={d.confidence} threshold={threshold} /></div>
            <div className="mt-1 flex flex-wrap items-center gap-1 text-[9px] font-semibold">
              <span className={cn('px-1 rounded border', live.status === 'confirmed' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-600 border-slate-300')}>
                {live.status === 'confirmed' ? 'KEPT' : 'REJECTED'}
              </span>
              {live.override && <span className="px-1 rounded border bg-blue-50 text-blue-700 border-blue-200 flex items-center gap-0.5"><ShieldAlert className="w-2.5 h-2.5" />operator {live.override}</span>}
              {nat && <span className={cn('px-1 rounded border', nat.badge)}>{nat.label}</span>}
              {!nat && live.status !== 'confirmed' && live.reasons[0] && <span className="px-1 rounded border bg-slate-50 text-slate-600 border-slate-200">{SUPPRESSION_LABELS[live.reasons[0]] ?? live.reasons[0]}</span>}
              {d.quality?.flags?.length > 0 && <span className="px-1 rounded border bg-amber-50 text-amber-700 border-amber-200">{d.quality.flags.length} data-quality flag{d.quality.flags.length > 1 ? 's' : ''}</span>}
            </div>
            {sel && <Detail d={d} live={live} onReview={onReview} />}
          </div>
        );
      })}
    </div>
  );
}
