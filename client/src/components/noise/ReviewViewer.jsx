import { useState } from 'react';
import { ImageOff, Loader2, Maximize2, Minus, Plus } from 'lucide-react';
import { classColor, classLabel } from '../../utils/classes';
import { liveStatus } from '../../utils/noise';
import { containRect, useBoxSize, useZoomPan } from './useZoomPan';

/**
 * Stage-2 review: the AI-cleaned scan with every candidate drawn by its live status (kept = class colour,
 * rejected = grey dashed, operator decision = thick outline) and its acoustic shadow outlined in violet.
 */
export default function ReviewViewer({ imageUrl, frame, detections = [], threshold, selectedId, onSelect, showRejected, showShadows, loading }) {
  const [el, setEl] = useState(null);           // callback ref: hooks attach when the element exists
  const box = useBoxSize(el);
  const zp = useZoomPan(el);
  const [natural, setNatural] = useState(null);
  const W = frame?.width || natural?.w;
  const H = frame?.height || natural?.h;
  const rect = containRect(box, natural ? { w: natural.w, h: natural.h } : null);

  const items = detections.map((d) => ({ d, live: liveStatus(d, threshold) }))
    .filter(({ live }) => showRejected || live.status === 'confirmed');

  return (
    <div ref={setEl} className="absolute inset-0 overflow-hidden select-none touch-none cursor-grab active:cursor-grabbing" {...zp.handlers}>
      {imageUrl ? (
        <div className="absolute inset-0 origin-top-left" style={{ transform: zp.transform }}>
          <img
            src={imageUrl}
            alt="Cleaned sonar scan"
            draggable={false}
            onLoad={(e) => setNatural({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
            className="absolute"
            style={rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : { opacity: 0 }}
          />
          {rect && W && H && (
            <svg className="absolute overflow-visible" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
              viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
              {showShadows && items.map(({ d }) => d.shadow?.found && d.shadow.polygon?.length > 2 && (
                <polygon key={`sh-${d.id}`} points={d.shadow.polygon.map((p) => p.join(',')).join(' ')}
                  fill="#8b5cf6" fillOpacity={0.28} stroke="#a78bfa" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              ))}
              {items.map(({ d, live }) => {
                const kept = live.status === 'confirmed';
                const color = kept ? classColor(d.className) : '#94a3b8';
                const sel = d.id === selectedId;
                return (
                  <g key={d.id} style={{ pointerEvents: 'all' }} className="cursor-pointer"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onSelect?.(d.id); }}>
                    {d.polygons?.map((poly, i) => (
                      <polygon key={i} points={poly.map((p) => p.join(',')).join(' ')} fill={color} fillOpacity={sel ? 0.35 : 0.18}
                        stroke={color} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                    ))}
                    <rect x={d.bbox.x1} y={d.bbox.y1} width={d.bbox.width} height={d.bbox.height}
                      fill={color} fillOpacity={0.08} stroke={sel ? '#ffffff' : color}
                      strokeWidth={live.override ? 3.5 : sel ? 3 : 1.8} vectorEffect="non-scaling-stroke"
                      strokeDasharray={kept ? undefined : '6 4'} />
                  </g>
                );
              })}
            </svg>
          )}
        </div>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-500 text-xs font-mono gap-2">
          <ImageOff className="w-8 h-8" />
          Run detection to review candidates
        </div>
      )}

      {/* labels stay readable at any zoom */}
      {rect && W && H && items.map(({ d, live }) => {
        const x = zp.view.x + (rect.left + (d.bbox.x1 / W) * rect.width) * zp.view.zoom;
        const y = zp.view.y + (rect.top + (d.bbox.y1 / H) * rect.height) * zp.view.zoom;
        if (box && (x < -60 || y < 0 || x > box.w || y > box.h + 20)) return null;
        const kept = live.status === 'confirmed';
        return (
          <button key={`l-${d.id}`} type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onSelect?.(d.id)}
            className="absolute -translate-y-full text-[10px] font-mono font-bold px-1 py-0.5 rounded-t whitespace-nowrap shadow cursor-pointer text-white"
            style={{ left: x, top: y, background: kept ? classColor(d.className) : '#64748b', outline: d.id === selectedId ? '2px solid white' : undefined }}
            title={`${classLabel(d.className)} · ${d.confidence.toFixed(1)}%`}>
            {d.code} {d.confidence.toFixed(0)}%{live.override === 'confirmed' ? ' ✓' : live.override === 'rejected' ? ' ✗' : ''}
          </button>
        );
      })}

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
