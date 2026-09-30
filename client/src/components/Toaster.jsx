import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { useToastStore } from '../store/useToastStore';
import { cn } from '../utils/cn';

const STYLES = {
  success: { icon: CheckCircle2, className: 'border-emerald-300', iconClass: 'text-emerald-600' },
  info: { icon: Info, className: 'border-blue-300', iconClass: 'text-blue-600' },
  error: { icon: AlertTriangle, className: 'border-red-300', iconClass: 'text-red-600' },
};

export default function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div className="fixed top-4 right-6 z-[2100] flex flex-col gap-2 w-[380px] max-w-[90vw] pointer-events-none">
      {toasts.map((t) => {
        const { icon: Icon, className, iconClass } = STYLES[t.type] ?? STYLES.info;
        return (
          <div
            key={t.id}
            role={t.type === 'error' ? 'alert' : 'status'}
            className={cn('pointer-events-auto bg-white/95 border text-slate-800 text-xs px-3.5 py-2.5 rounded-lg shadow-lg flex items-start gap-2 backdrop-blur-md font-medium', className)}
          >
            <Icon className={cn('w-4 h-4 shrink-0 mt-px', iconClass)} />
            <span className="flex-1 break-words">{t.message}</span>
            <button type="button" onClick={() => dismiss(t.id)} className="text-slate-400 hover:text-slate-700 cursor-pointer" aria-label="Dismiss">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
