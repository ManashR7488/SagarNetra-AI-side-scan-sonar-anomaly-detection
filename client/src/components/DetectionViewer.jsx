import { useLayoutEffect, useRef, useState } from 'react';
import { ImageOff, Loader2 } from 'lucide-react';
import { classColor, classLabel } from '../utils/classes';

/** Size & position of an image drawn with object-fit: contain inside a container. */
function useContainRect(containerRef, natural) {
  const [rect, setRect] = useState(null);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || !natural) return undefined;
    const update = () => {
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      const s = Math.min(cw / natural.w, ch / natural.h);
      const w = natural.w * s;
      const h = natural.h * s;
      setRect({ left: (cw - w) / 2, top: (ch - h) / 2, width: w, height: h });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef, natural]);
  return rect;
}

/**
 * Sonar image with detection boxes and segmentation masks drawn over it.
 * `detections` use pixel coordinates of the analysed image (`frame` = { width, height }).
 */
export default function DetectionViewer({
  imageUrl, frame, detections = [], selectedId, onSelect, showSuppressed = false, showMasks = true, loading = false,
  imageClassName = '',
}) {
  const containerRef = useRef(null);
  const [natural, setNatural] = useState(null);
  const [failed, setFailed] = useState(false);
  const rect = useContainRect(containerRef, natural);

  const W = frame?.width || natural?.w;
  const H = frame?.height || natural?.h;
  const visible = detections.filter((d) => showSuppressed || d.status === 'confirmed');

  return (
    <div ref={containerRef} className="absolute inset-0">
      {imageUrl && !failed ? (
        <img
          key={imageUrl}
          src={imageUrl}
          alt="Sonar scan"
          draggable={false}
          onLoad={(e) => { setNatural({ w: e.target.naturalWidth, h: e.target.naturalHeight }); setFailed(false); }}
          onError={() => setFailed(true)}
          className={`absolute select-none ${imageClassName}`}
          style={rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : { opacity: 0 }}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-500 text-xs font-mono gap-2">
          <ImageOff className="w-8 h-8" />
          {failed ? 'Image could not be loaded' : 'No preview available for this file type'}
        </div>
      )}

      {rect && W && H && visible.length > 0 && (
        <>
          <svg
            className="absolute"
            style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
          >
            {visible.map((d) => {
              const color = d.status === 'confirmed' ? classColor(d.className) : '#94a3b8';
              const sel = d.id === selectedId;
              return (
                <g key={d.id} onClick={() => onSelect?.(d)} className="cursor-pointer" style={{ pointerEvents: 'all' }}>
                  {showMasks && d.polygons?.map((poly, i) => (
                    <polygon key={i} points={poly.map((p) => p.join(',')).join(' ')} fill={color} fillOpacity={sel ? 0.4 : 0.25}
                      stroke={color} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                  ))}
                  <rect
                    x={d.bbox.x1} y={d.bbox.y1} width={d.bbox.width} height={d.bbox.height}
                    fill={showMasks && d.polygons?.length ? 'transparent' : color} fillOpacity={0.12}
                    stroke={sel ? '#ffffff' : color} strokeWidth={sel ? 3 : 2} vectorEffect="non-scaling-stroke"
                    strokeDasharray={d.status === 'confirmed' ? undefined : '6 4'}
                  />
                </g>
              );
            })}
          </svg>
          {visible.map((d) => (
            <button
              type="button"
              key={`label-${d.id}`}
              onClick={() => onSelect?.(d)}
              className="absolute -translate-y-full text-white text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-t whitespace-nowrap shadow-md cursor-pointer"
              style={{
                left: rect.left + (d.bbox.x1 / W) * rect.width,
                top: rect.top + (d.bbox.y1 / H) * rect.height,
                background: d.status === 'confirmed' ? classColor(d.className) : '#64748b',
                outline: d.id === selectedId ? '2px solid white' : undefined,
              }}
              title={`${classLabel(d.className)} · ${d.confidence.toFixed(1)}%${d.status === 'suppressed' ? ' (suppressed)' : ''}`}
            >
              {d.code} {classLabel(d.className).split(' ')[0]} {d.confidence.toFixed(0)}%
            </button>
          ))}
        </>
      )}

      {loading && (
        <div className="absolute inset-0 bg-slate-950/50 flex items-center justify-center">
          <Loader2 className="w-8 h-8 text-white animate-spin" />
        </div>
      )}
    </div>
  );
}
