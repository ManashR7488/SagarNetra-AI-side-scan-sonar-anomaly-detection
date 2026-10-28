import { useRef, useState } from 'react';
import { ImageOff, Loader2, Maximize2, Minus, Plus } from 'lucide-react';
import { containRect, useBoxSize, useZoomPan } from './useZoomPan';

function Fitted({ src, box, transform, onNatural, natural, className = '' }) {
  const rect = containRect(box, natural);
  return (
    <div className="absolute inset-0 origin-top-left" style={{ transform }}>
      {src && (
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={(e) => onNatural({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
          className={`absolute select-none ${className}`}
          style={rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height, imageRendering: 'auto' } : { opacity: 0 }}
        />
      )}
    </div>
  );
}

/**
 * Before / after comparison: drag the divider, wheel to zoom (around the cursor), drag to pan, double-click to reset.
 * Both images are fitted into the same box, so steps that change the geometry stay roughly aligned.
 */
export default function CompareSlider({ before, after, beforeLabel = 'Before', afterLabel = 'After', loading = false, empty }) {
  const [el, setEl] = useState(null);           // callback ref: hooks attach when the element exists
  const box = useBoxSize(el);
  const zp = useZoomPan(el);
  const [split, setSplit] = useState(0.5);
  const [natB, setNatB] = useState(null);
  const [natA, setNatA] = useState(null);
  const dragging = useRef(false);

  const moveSplit = (clientX) => {
    const r = el.getBoundingClientRect();
    setSplit(Math.min(1, Math.max(0, (clientX - r.left) / r.width)));
  };

  if (!before && !after) {
    return (
      <div ref={setEl} className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-500 text-xs font-mono">
        {loading ? <Loader2 className="w-7 h-7 animate-spin text-slate-300" /> : <ImageOff className="w-8 h-8" />}
        {loading ? 'Measuring and cleaning…' : empty ?? 'No image'}
      </div>
    );
  }

  return (
    <div ref={setEl} className="absolute inset-0 overflow-hidden select-none cursor-grab active:cursor-grabbing touch-none" {...zp.handlers}>
      <Fitted src={before} box={box} transform={zp.transform} natural={natB} onNatural={setNatB} />
      <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${split * 100}%)` }}>
        <Fitted src={after ?? before} box={box} transform={zp.transform} natural={natA} onNatural={setNatA} />
      </div>

      {/* divider */}
      <div
        className="absolute top-0 bottom-0 w-6 -ml-3 cursor-ew-resize z-10 group"
        style={{ left: `${split * 100}%` }}
        onPointerDown={(e) => { e.stopPropagation(); dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { if (dragging.current) { e.stopPropagation(); moveSplit(e.clientX); } }}
        onPointerUp={(e) => { e.stopPropagation(); dragging.current = false; }}
        onDoubleClick={(e) => { e.stopPropagation(); setSplit(0.5); }}
      >
        <div className="absolute inset-y-0 left-1/2 w-0.5 -ml-px bg-cyan-300 shadow-[0_0_6px_rgba(34,211,238,0.9)]" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-6 h-10 rounded-full bg-slate-900/80 border border-cyan-300 flex items-center justify-center text-cyan-200 text-[10px] font-bold">
          ⇆
        </div>
      </div>

      <span className="absolute top-2 left-2 z-10 text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-slate-900/80 text-slate-200 border border-slate-700 pointer-events-none">
        {beforeLabel}
      </span>
      <span className="absolute top-2 right-2 z-10 text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-cyan-900/80 text-cyan-100 border border-cyan-700 pointer-events-none">
        {afterLabel}
      </span>

      <div className="absolute bottom-2 right-2 z-10 flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
        <span className="text-[10px] font-mono text-slate-300 bg-slate-900/70 px-1.5 py-0.5 rounded">{zp.view.zoom.toFixed(1)}×</span>
        <button type="button" onClick={() => zp.zoomBy(1 / 1.5)} className="p-1 rounded bg-slate-900/70 text-slate-200 hover:bg-slate-800 cursor-pointer" title="Zoom out"><Minus className="w-3 h-3" /></button>
        <button type="button" onClick={() => zp.zoomBy(1.5)} className="p-1 rounded bg-slate-900/70 text-slate-200 hover:bg-slate-800 cursor-pointer" title="Zoom in"><Plus className="w-3 h-3" /></button>
        <button type="button" onClick={zp.reset} className="p-1 rounded bg-slate-900/70 text-slate-200 hover:bg-slate-800 cursor-pointer" title="Fit (double-click)"><Maximize2 className="w-3 h-3" /></button>
      </div>

      {loading && (
        <div className="absolute inset-0 bg-slate-950/50 flex items-center justify-center z-20">
          <Loader2 className="w-8 h-8 text-white animate-spin" />
        </div>
      )}
    </div>
  );
}
