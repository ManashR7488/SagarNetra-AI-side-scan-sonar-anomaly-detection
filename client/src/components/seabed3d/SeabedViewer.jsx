import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Navigation2 } from 'lucide-react';
import { loadSeabed } from './seabedData';

/**
 * React wrapper around SeabedScene (three.js, loaded lazily). `lines` = [{ scan, targets, primary }] (selected scan
 * first, then neighbouring lines). Display settings are props; camera actions go through `ref`.
 */
export default function SeabedViewer({
  ref, lines, geo, colorMode, exaggeration, contours, coverage, showTrack, showTargets, classes, includeSuppressed,
  tool, selectedKey, followT, onSelect, onPointer, onMeasure, onReady,
}) {
  const hostRef = useRef(null);
  const labelsRef = useRef(null);
  const arrowRef = useRef(null);
  const scaleBarRef = useRef(null);
  const scaleTextRef = useRef(null);
  const sceneRef = useRef(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  const [layout, setLayout] = useState({ geo: false, lines: 0 });
  const callbacks = useRef({});
  callbacks.current = { onSelect, onPointer, onMeasure, onReady };

  // Rebuild when the set of lines (or the layout) changes; display settings are applied below.
  const key = `${geo ? 'geo' : 'straight'}|${lines.map((l) => l.scan.seabed?.elevation?.file?.url).join('|')}`;

  useEffect(() => {
    if (!lines.length || !lines[0].scan.seabed?.available) return undefined;
    let scene = null;
    let cancelled = false;
    const abort = new AbortController();
    setStatus('loading');
    setError(null);

    const loads = lines.map((l) => loadSeabed(l.scan.seabed, { signal: abort.signal })
      .then((model) => ({
        model,
        textureUrl: l.scan.seabed.texture.url,
        scanId: l.scan.id,
        name: l.scan.name || l.scan.source?.filename,
        primary: l.primary,
        targets: l.targets,
      }))
      .catch((err) => {
        if (l.primary) throw err;                        // a neighbour that fails to load is just left out
        console.warn('neighbouring line skipped', err);
        return null;
      }));

    Promise.all([import('./SeabedScene'), Promise.all(loads)])
      .then(([{ default: SeabedScene }, strips]) => {
        if (cancelled) return null;
        // Disposed straight away if this effect is cleaned up mid-build (StrictMode, switching scans).
        scene = new SeabedScene({
          host: hostRef.current,
          labels: labelsRef.current,
          overlay: { arrow: arrowRef.current, scaleBar: scaleBarRef.current, scaleText: scaleTextRef.current },
          onSelect: (k) => callbacks.current.onSelect?.(k),
          onPointer: (p) => callbacks.current.onPointer?.(p),
          onMeasure: (m) => callbacks.current.onMeasure?.(m),
        });
        sceneRef.current = scene;
        return scene.build(strips.filter(Boolean), { geo });
      })
      .then(() => {
        if (cancelled || !scene || scene.disposed) return;
        const info = { geo: scene.geo, lines: scene.strips.length, colorRange: scene.colorRange, contour: scene.common.uContour.value };
        setLayout(info);
        callbacks.current.onReady?.(info);
        setStatus('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('3D seabed failed', err);
        setError(err.message);
        setStatus('failed');
      });

    return () => {
      cancelled = true;
      abort.abort();
      scene?.dispose();
      if (sceneRef.current === scene) sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const s = sceneRef.current;
    if (status !== 'ready' || !s) return;
    s.setExaggeration(exaggeration);
    s.setColorMode(colorMode);
    s.setContours(contours);
    s.setCoverage(coverage);
    s.setShowTrack(showTrack);
    s.setTargetFilter({ show: showTargets, classes, includeSuppressed });
    s.setTool(tool);
    s.setSelected(selectedKey);
  }, [status, exaggeration, colorMode, contours, coverage, showTrack, showTargets, classes, includeSuppressed, tool, selectedKey]);

  useEffect(() => {
    if (status === 'ready') sceneRef.current?.setFollow(followT);
  }, [status, followT]);

  useImperativeHandle(ref, () => ({
    view: (preset) => sceneRef.current?.view(preset),
    flyTo: (k) => sceneRef.current?.flyTo(k),
    clearMeasure: () => sceneRef.current?.clearMeasure(),
    snapshot: (caption) => sceneRef.current?.snapshot(caption),
  }), []);

  return (
    <div className="relative w-full h-full overflow-hidden bg-[#0a1626]">
      <div ref={hostRef} className="absolute inset-0" />
      <div ref={labelsRef} className="seabed-tags" aria-hidden={status !== 'ready'} />
      {/* North arrow (true geometry) or track direction (straightened) + scale bar */}
      <div className={`absolute top-12 right-2 flex flex-col items-center gap-1 pointer-events-none ${status === 'ready' ? '' : 'hidden'}`}>
        <div className="w-11 h-11 rounded-full bg-slate-900/70 border border-white/15 backdrop-blur flex items-center justify-center">
          <div ref={arrowRef} className="flex flex-col items-center">
            <Navigation2 className="w-4 h-4 text-red-400 fill-red-400" />
            <span className="text-[8px] font-bold font-mono text-slate-200 leading-none">{layout.geo ? 'N' : 'TRACK'}</span>
          </div>
        </div>
        <div className="bg-slate-900/70 border border-white/15 rounded px-1.5 py-1 backdrop-blur flex flex-col items-center">
          <div ref={scaleBarRef} className="h-1.5 border-x-2 border-b-2 border-slate-200" style={{ width: 80 }} />
          <span ref={scaleTextRef} className="text-[9px] font-mono text-slate-200 mt-0.5">—</span>
        </div>
      </div>
      {status === 'loading' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sky-100/80 text-xs font-mono">
          <Loader2 className="w-6 h-6 animate-spin" />Building the 3D seabed{lines.length > 1 ? ` (${lines.length} lines)` : ''}…
        </div>
      )}
      {status === 'failed' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-6 text-red-200 text-xs">
          <AlertTriangle className="w-6 h-6" />
          <span className="font-semibold">The 3D view could not be loaded.</span>
          <span className="font-mono text-red-200/80">{error}</span>
        </div>
      )}
    </div>
  );
}
