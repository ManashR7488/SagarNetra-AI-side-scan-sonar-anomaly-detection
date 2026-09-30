import { useEffect } from 'react';
import { X } from 'lucide-react';

export default function Modal({ open, title, icon: Icon, onClose, children, footer, width = 'max-w-lg' }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[2000] bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`bg-white rounded-xl border border-slate-200 shadow-xl w-full ${width} max-h-[90vh] flex flex-col`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
            {Icon && <Icon className="w-4 h-4 text-blue-600" />}
            {title}
          </div>
          <button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700 rounded cursor-pointer" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 overflow-y-auto text-xs text-slate-700">{children}</div>
        {footer && <div className="px-4 py-3 border-t border-slate-200 bg-slate-50 rounded-b-xl flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

/** Small labelled form field used by the dialogs. */
export function Field({ label, hint, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-semibold text-slate-700">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-slate-400">{hint}</span>}
    </label>
  );
}

export const inputClass = 'bg-white border border-slate-300 rounded-md px-2.5 py-1.5 text-xs font-mono text-slate-800 focus:outline-none focus:ring-1 focus:ring-blue-500';
