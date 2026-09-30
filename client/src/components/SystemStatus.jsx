import { useSystemStore } from '../store/useSystemStore';
import { cn } from '../utils/cn';

const dot = (ok, warn) => (ok ? 'bg-emerald-500' : warn ? 'bg-amber-500' : 'bg-red-500');

/** Live status of the backend, AI service and database (replaces the old simulated "AUV ONLINE" badge). */
export default function SystemStatus({ collapsed }) {
  const health = useSystemStore((s) => s.health);
  const healthError = useSystemStore((s) => s.healthError);

  const rows = [
    { label: 'API server', ok: Boolean(health), detail: healthError ? 'offline' : health ? 'online' : 'checking…' },
    { label: 'AI service', ok: health?.aiService?.status === 'ok', detail: health?.aiService?.status === 'ok' ? `${health.aiService.device?.toUpperCase?.() ?? ''} · ${health.aiService.modelsLoaded?.length ?? 0} models` : health?.aiService?.status ?? '—' },
    { label: 'Database', ok: health?.database === 'connected', detail: health?.database ?? '—' },
    { label: 'Storage', ok: Boolean(health?.storage), warn: health?.storage?.provider === 'local', detail: health?.storage?.provider ?? '—' },
  ];
  const allOk = rows.every((r) => r.ok);

  if (collapsed) {
    return (
      <div className="mx-auto my-2.5 p-1 rounded-full bg-slate-50 border border-slate-200" title={rows.map((r) => `${r.label}: ${r.detail}`).join('\n')}>
        <span className={cn('block w-2.5 h-2.5 rounded-full', dot(allOk), allOk && 'animate-pulse')} />
      </div>
    );
  }

  return (
    <div className="mx-3 my-3 p-2.5 rounded-lg bg-slate-50 border border-slate-200">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-mono font-bold text-slate-500 uppercase">System Status</span>
        <span className={cn('flex items-center gap-1 text-[10px] font-mono font-semibold', allOk ? 'text-emerald-600' : 'text-red-600')}>
          <span className={cn('w-2 h-2 rounded-full', dot(allOk), allOk && 'animate-pulse')} />
          {allOk ? 'ONLINE' : 'DEGRADED'}
        </span>
      </div>
      <div className="space-y-0.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between text-[10px] font-mono">
            <span className="flex items-center gap-1.5 text-slate-600">
              <span className={cn('w-1.5 h-1.5 rounded-full', dot(r.ok && !r.warn, r.warn))} />
              {r.label}
            </span>
            <span className="text-slate-500 truncate max-w-[110px]" title={r.detail}>{r.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
