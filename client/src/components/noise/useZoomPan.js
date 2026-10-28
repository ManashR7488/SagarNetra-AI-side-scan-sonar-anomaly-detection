import { useCallback, useEffect, useRef, useState } from 'react';

const MIN_ZOOM = 1;
const MAX_ZOOM = 24;

/**
 * Wheel-zoom around the cursor and drag-to-pan for an element whose content is transformed with
 * `translate(pan) scale(zoom)` (origin top-left). Double-click resets. `el` is the container element
 * (from a callback ref kept in state, so listeners attach whenever the element appears).
 */
export function useZoomPan(el) {
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const drag = useRef(null);

  const clamp = useCallback((v) => {
    if (!el) return v;
    const w = el.clientWidth;
    const h = el.clientHeight;
    // keep the zoomed content covering the container
    const minX = w - w * v.zoom;
    const minY = h - h * v.zoom;
    return { zoom: v.zoom, x: Math.min(0, Math.max(minX, v.x)), y: Math.min(0, Math.max(minY, v.y)) };
  }, [el]);

  useEffect(() => {
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      setView((v) => {
        const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * Math.exp(-e.deltaY * 0.0015)));
        const k = zoom / v.zoom;
        return clamp({ zoom, x: px - (px - v.x) * k, y: py - (py - v.y) * k });
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [el, clamp]);

  const onPointerDown = useCallback((e) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, view, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, [view]);

  const onPointerMove = useCallback((e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    setView(clamp({ zoom: d.view.zoom, x: d.view.x + dx, y: d.view.y + dy }));
  }, [clamp]);

  const onPointerUp = useCallback(() => {
    drag.current = null;
  }, []);

  const reset = useCallback(() => setView({ zoom: 1, x: 0, y: 0 }), []);
  const zoomBy = useCallback((f) => {
    const cx = (el?.clientWidth ?? 0) / 2;
    const cy = (el?.clientHeight ?? 0) / 2;
    setView((v) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * f));
      const k = zoom / v.zoom;
      return clamp({ zoom, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k });
    });
  }, [el, clamp]);

  const transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
  return { view, transform, reset, zoomBy, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onDoubleClick: reset } };
}

/** Rectangle of an image of natural size `nat` drawn with object-fit: contain in a box of size `box`. */
export function containRect(box, nat) {
  if (!box || !nat) return null;
  const s = Math.min(box.w / nat.w, box.h / nat.h);
  const w = nat.w * s;
  const h = nat.h * s;
  return { left: (box.w - w) / 2, top: (box.h - h) / 2, width: w, height: h };
}

/** Observed size of an element (null until it exists). */
export function useBoxSize(el) {
  const [box, setBox] = useState(null);
  useEffect(() => {
    if (!el) return undefined;
    const update = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return box;
}
