import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowUpToLine, Box, Camera, CheckCircle2, Crosshair, Eye, Globe2, Info, Layers, Loader2, Maximize2, Mountain,
  MousePointer2, Move3d, PanelRight, Pause, Play, RefreshCw, Ruler, ScanSearch, Ship, SlidersHorizontal, Trash2,
  TriangleAlert, Waypoints,
} from 'lucide-react';
import { cn } from '../../utils/cn';
import { scansApi } from '../../api';
import { errorMessage } from '../../config/axios';
import { useMissionStore } from '../../store/useMissionStore';
import { toast } from '../../store/useToastStore';
import { CLASS_NAMES, classColor, classLabel } from '../../utils/classes';
import { downloadDataUrl } from '../../utils/download';
import { fmtLat, fmtLon, fmtNum, fmtPoint } from '../../utils/format';
import SeabedViewer from '../../components/seabed3d/SeabedViewer';

const SHORT = {
  shipwreck: 'Wreck', aircraft_wreck: 'Aircraft', mine_like_object: 'Mine-like', debris: 'Debris',
  human_body: 'Body', marine_life: 'Marine life',
};
const COLOR_MODES = [
  { id: 'sonar', label: 'Sonar', title: 'Side-scan backscatter draped on the relief' },
  { id: 'depth', label: 'Depth', title: 'Colour by depth / elevation' },
  { id: 'shade', label: 'Relief', title: 'Plain hillshade: shape only' },
];
const VIEWS = [
  { id: 'oblique', label: 'Fit', icon: Maximize2 },
  { id: 'top', label: 'Top', icon: ArrowUpToLine },
  { id: 'side', label: 'Side', icon: PanelRight },
  { id: 'along', label: 'Along track', icon: Move3d },
];
const SOURCE_LABEL = {
  logged: 'logged by the sonar',
  'logged+image': 'logged, verified on the image',
  image: 'tracked from the image',
  assumed: 'assumed',
};
const FOLLOW_SECONDS = 45;
const MAX_NEIGHBOURS = 6;
const SONAR_GRADIENT = 'linear-gradient(90deg,#050302,#3a1d06,#b86a14,#f2c46a,#fff6dc)';
const DEPTH_GRADIENT = 'linear-gradient(90deg,#0b1d51,#1d4f91,#1f8fae,#5cc8a5,#e8e0a0)';

function Card({ title, icon: Icon, children, className, right }) {
  return (
    <section className={cn('bg-white border border-slate-200 rounded-lg shadow-xs', className)}>
      <header className="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-200 bg-slate-50 rounded-t-lg">
        <h3 className="flex items-center gap-1.5 text-[11px] font-mono font-bold text-slate-700 uppercase tracking-wide min-w-0">
          {Icon && <Icon className="w-3.5 h-3.5 text-blue-600 shrink-0" />}<span className="truncate">{title}</span>
        </h3>
        {right}
      </header>
      <div className="p-3 text-xs text-slate-700">{children}</div>
    </section>
  );
}

function Row({ label, children, title, strong }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5" title={title}>
      <span className="text-slate-500 shrink-0">{label}</span>
      <span className={cn('font-mono text-right truncate', strong ? 'text-slate-950 font-bold' : 'text-slate-900')}>{children}</span>
    </div>
  );
}

function Toggle({ checked, onChange, children, title, disabled }) {
  return (
    <label className={cn('flex items-center gap-1.5 text-[11px] text-slate-700 select-none', disabled ? 'opacity-40' : 'cursor-pointer')} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="accent-blue-600" />
      {children}
    </label>
  );
}

function Segmented({ value, options, onChange }) {
  return (
    <div className="flex rounded-md border border-slate-300 overflow-hidden text-[11px] font-semibold">
      {options.map((o) => (
        <button key={o.id} type="button" title={o.title} onClick={() => onChange(o.id)} disabled={o.disabled}
          className={cn('flex-1 px-2 py-1 cursor-pointer border-l first:border-l-0 border-slate-300 disabled:opacity-40 disabled:cursor-not-allowed',
            value === o.id ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Elevation profile of the measured line (true scale, no exaggeration). */
function Profile({ profile }) {
  if (profile.length < 2) return null;
  const w = 260;
  const h = 70;
  const hs = profile.map((p) => p.h);
  const lo = Math.min(...hs);
  const hi = Math.max(...hs);
  const span = Math.max(hi - lo, 0.05);
  const dMax = profile.at(-1).d || 1;
  const pts = profile.map((p) => `${(p.d / dMax) * w},${h - 6 - ((p.h - lo) / span) * (h - 14)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-16 bg-slate-50 rounded border border-slate-200" preserveAspectRatio="none">
      <polygon points={`0,${h} ${pts} ${w},${h}`} fill="#fbcfe8" opacity="0.6" />
      <polyline points={pts} fill="none" stroke="#db2777" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      <text x="4" y="11" fontSize="9" fill="#64748b" fontFamily="monospace">{fmtNum(hi, 2, ' m')}</text>
      <text x="4" y={h - 3} fontSize="9" fill="#64748b" fontFamily="monospace">{fmtNum(lo, 2, ' m')}</text>
    </svg>
  );
}

/** The detection in the original 2D sonar image (what the operator saw), with its box. */
function SonarCrop({ scan, det }) {
  const url = scan?.images?.annotated?.url ?? scan?.images?.filtered?.url;
  const W = scan?.source?.width;
  const H = scan?.source?.height;
  const b = det?.bbox;
  if (!url || !W || !H || !b) return null;
  const pad = Math.max(b.width, b.height) * 0.6 + 20;
  const x0 = Math.max(0, b.x1 - pad);
  const y0 = Math.max(0, b.y1 - pad);
  const x1 = Math.min(W, b.x2 + pad);
  const y1 = Math.min(H, b.y2 + pad);
  return (
    <svg viewBox={`${x0} ${y0} ${x1 - x0} ${y1 - y0}`} preserveAspectRatio="xMidYMid meet"
      className="w-full h-36 bg-slate-950 rounded border border-slate-200 mb-2" role="img" aria-label="Detection in the 2D sonar image">
      <image href={url} x="0" y="0" width={W} height={H} preserveAspectRatio="none" />
    </svg>
  );
}

/** Distance (m) between two tracks given by their start / end points (equirectangular, fine at survey scale). */
function lineDistance(a, b) {
  const pts = (g) => {
    const [lo0, la0] = g.start.coordinates;
    const [lo1, la1] = g.end.coordinates;
    return Array.from({ length: 9 }, (_, i) => [la0 + ((la1 - la0) * i) / 8, lo0 + ((lo1 - lo0) * i) / 8]);
  };
  const pa = pts(a);
  const pb = pts(b);
  const ky = 111_320;
  const kx = ky * Math.cos((pa[4][0] * Math.PI) / 180);
  let best = Infinity;
  for (const [la, lo] of pa) {
    for (const [lb, lob] of pb) best = Math.min(best, Math.hypot((la - lb) * ky, (lo - lob) * kx));
  }
  return best;
}

const sideLabel = (u) => `${fmtNum(Math.abs(u), 1, ' m')} ${u >= 0 ? 'stbd' : 'port'}`;
const targetsOf = (scan) => {
  const dets = new Map((scan?.detections ?? []).map((d) => [d.code, d]));
  return (scan?.seabed?.targets ?? []).map((t) => {
    const d = dets.get(t.detectionCode);
    return {
      ...t,
      color: classColor(t.className),
      label: SHORT[t.className] ?? classLabel(t.className),
      sizeM: t.sizeM ?? (d?.dimensions ? Math.max(d.dimensions.acrossTrackM ?? 0, d.dimensions.alongTrackM ?? 0) || undefined : undefined),
    };
  });
};

export default function Seabed3DTab() {
  const activeMissionId = useMissionStore((s) => s.activeMissionId);
  const dataVersion = useMissionStore((s) => s.dataVersion);
  const [params, setParams] = useSearchParams();
  const scanId = params.get('scan');

  const [scans, setScans] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [scan, setScan] = useState(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [neighbourScans, setNeighbourScans] = useState([]);

  const [colorMode, setColorMode] = useState('sonar');
  const [exaggeration, setExaggeration] = useState(3);
  const [contours, setContours] = useState(false);
  const [coverage, setCoverage] = useState(false);
  const [showTrack, setShowTrack] = useState(true);
  const [showTargets, setShowTargets] = useState(true);
  const [includeSuppressed, setIncludeSuppressed] = useState(false);
  const [hiddenClasses, setHiddenClasses] = useState([]);
  const [geoMode, setGeoMode] = useState(true);
  const [withNeighbours, setWithNeighbours] = useState(true);
  const [tool, setTool] = useState('orbit');
  const [selectedKey, setSelectedKey] = useState(null);
  const [followT, setFollowT] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [pointer, setPointer] = useState(null);
  const [measure, setMeasure] = useState(null);
  const [layout, setLayout] = useState(null);
  const [swathInput, setSwathInput] = useState('');
  const viewerRef = useRef(null);

  // Completed scans of the active mission; the ones with a 3D model first.
  useEffect(() => {
    let cancelled = false;
    setListLoading(true);
    scansApi.list({ missionId: activeMissionId ?? undefined, status: 'completed', limit: 100 })
      .then(({ data }) => !cancelled && setScans(data))
      .catch((err) => !cancelled && toast.error(errorMessage(err)))
      .finally(() => !cancelled && setListLoading(false));
    return () => { cancelled = true; };
  }, [activeMissionId, dataVersion]);

  const ordered = useMemo(
    () => [...scans].sort((a, b) => Number(Boolean(b.seabed?.available)) - Number(Boolean(a.seabed?.available))),
    [scans],
  );
  const currentId = scanId ?? ordered.find((s) => s.seabed?.available)?.id ?? ordered[0]?.id ?? null;

  useEffect(() => {
    if (!currentId) return setScan(null);
    let cancelled = false;
    setScanLoading(true);
    scansApi.get(currentId)
      .then((s) => !cancelled && setScan(s))
      .catch((err) => { if (!cancelled) { setScan(null); toast.error(errorMessage(err)); } })
      .finally(() => !cancelled && setScanLoading(false));
    setSelectedKey(null);
    setMeasure(null);
    setFollowT(null);
    setPlaying(false);
    setSwathInput('');
    return () => { cancelled = true; };
  }, [currentId]);

  const seabed = scan?.seabed;
  const measured = seabed?.kind === 'measured';
  const georef = Boolean(scan?.georeference?.available && scan.georeference.start && scan.georeference.end && seabed?.track?.lat?.length > 1);

  // Neighbouring survey lines: other scans of this mission whose swath overlaps or adjoins this one.
  const neighbourCandidates = useMemo(() => {
    if (!georef || !seabed?.available) return [];
    return scans
      .filter((s) => s.id !== scan.id && s.seabed?.available && s.seabed.kind === seabed.kind
        && s.georeference?.available && s.georeference.start && s.georeference.end)
      .map((s) => ({ s, d: lineDistance(scan.georeference, s.georeference) }))
      .filter(({ s, d }) => d <= (seabed.grid.widthM + s.seabed.grid.widthM) / 2 + 30)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_NEIGHBOURS);
  }, [scans, scan, seabed, georef]);

  useEffect(() => {
    if (!withNeighbours || !geoMode || !neighbourCandidates.length) return setNeighbourScans([]);
    let cancelled = false;
    Promise.all(neighbourCandidates.map(({ s }) => scansApi.get(s.id).catch(() => null)))
      .then((list) => !cancelled && setNeighbourScans(list.filter((s) => s?.seabed?.available)));
    return () => { cancelled = true; };
  }, [withNeighbours, geoMode, neighbourCandidates]);

  const lines = useMemo(() => (seabed?.available ? [
    { scan, targets: targetsOf(scan), primary: true },
    ...(geoMode && georef && withNeighbours ? neighbourScans.map((s) => ({ scan: s, targets: targetsOf(s), primary: false })) : []),
  ] : []), [scan, seabed, neighbourScans, geoMode, georef, withNeighbours]);

  const allTargets = useMemo(() => lines.flatMap((l) => l.targets.map((t) => ({
    ...t, key: `${l.scan.id}:${t.detectionCode}`, line: l,
  }))), [lines]);
  const classes = useMemo(() => CLASS_NAMES.filter((c) => !hiddenClasses.includes(c)), [hiddenClasses]);
  const presentClasses = useMemo(() => [...new Set(allTargets.map((t) => t.className))], [allTargets]);

  // Track fly-through playback.
  useEffect(() => {
    if (!playing) return undefined;
    let raf;
    let last = performance.now();
    const tick = (now) => {
      const dt = (now - last) / 1000;
      last = now;
      let done = false;
      setFollowT((t) => {
        const next = (t ?? 0) + dt / FOLLOW_SECONDS;
        if (next >= 1) done = true;
        return Math.min(next, 1);
      });
      if (done) setPlaying(false);
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const selectScan = (id) => setParams(id ? { scan: id } : {});
  const selectTarget = (key) => {
    setSelectedKey(key);
    setFollowT(null);
    setPlaying(false);
    viewerRef.current?.flyTo(key);
  };
  const setView = (id) => {
    setFollowT(null);
    setPlaying(false);
    viewerRef.current?.view(id);
  };
  const changeTool = (t) => {
    setTool(t);
    if (t !== 'measure') setMeasure(null);
  };

  const rebuild = async (options = {}) => {
    if (!scan) return;
    setRebuilding(true);
    try {
      const updated = await scansApi.reanalyze(scan.id, options);
      setScan(updated);
      setScans((list) => list.map((s) => (s.id === updated.id ? { ...s, seabed: updated.seabed, georeference: updated.georeference } : s)));
      toast.success(updated.seabed?.available ? '3D seabed model rebuilt' : 'Re-analysed, but no 3D model was produced');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRebuilding(false);
    }
  };

  const saveSnapshot = () => {
    const caption = `SagarNetra 3D seabed · ${scan.name || scan.source?.filename} · ${measured ? 'measured depth' : 'relative elevation'}`
      + ` · vertical x${exaggeration} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    const url = viewerRef.current?.snapshot(caption);
    if (url) downloadDataUrl(url, `seabed3d_${(scan.name || scan.id).replace(/[^\w-]+/g, '_')}.png`);
  };

  const selected = selectedKey ? allTargets.find((t) => t.key === selectedKey) : null;
  const selectedDet = selected ? selected.line.scan.detections?.find((d) => d.code === selected.detectionCode) : null;
  const depthText = (p) => (p && Number.isFinite(p.h) ? (measured ? fmtNum(p.depth, 2, ' m') : `${p.h >= 0 ? '+' : ''}${fmtNum(p.h, 2, ' m')}`) : '—');

  const src = seabed?.geometry?.sources ?? {};
  const scaleUnknown = seabed?.available && src.scale === 'assumed';
  const canCalibrate = seabed?.available && scan?.source?.format !== 'xtf' && !scan?.georeference?.available;
  const nadirZone = seabed?.coverage?.nadirZoneM;
  const maxSpacing = seabed?.available && nadirZone != null ? Math.max(0, (seabed.grid.widthM - nadirZone) / 2) : null;
  const nearest = neighbourCandidates[0]?.d;

  return (
    <div className="flex flex-col h-full bg-slate-100 text-slate-900 p-3 gap-3 overflow-hidden font-sans">
      {/* Scan picker + model badge */}
      <div className="flex flex-wrap items-center gap-3 bg-white border border-slate-200 rounded-lg px-3 py-2 shadow-xs shrink-0">
        <div className="flex items-center gap-1.5 text-xs font-mono font-bold text-slate-700">
          <Box className="w-4 h-4 text-blue-600" />3D SEABED
        </div>
        <div className="h-4 w-px bg-slate-200" />
        <select value={currentId ?? ''} onChange={(e) => selectScan(e.target.value)} disabled={listLoading || !ordered.length}
          aria-label="Scan" className="bg-slate-50 border border-slate-300 rounded-md px-2 py-1 text-xs font-mono max-w-[340px] truncate cursor-pointer">
          {!ordered.length && <option value="">{listLoading ? 'Loading scans…' : 'No analysed scans in this mission'}</option>}
          {ordered.map((s) => (
            <option key={s.id} value={s.id}>
              {s.seabed?.available ? '● ' : '○ '}{s.name || s.source?.filename}{s.source?.format === 'xtf' ? ' (XTF)' : ''}
            </option>
          ))}
        </select>
        {seabed?.available && (
          <span className={cn('px-2 py-0.5 rounded-full text-[10px] font-bold border',
            measured ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200')}
          title={seabed.methods?.depth}>
            {measured ? 'MEASURED DEPTH' : 'RELATIVE · ESTIMATED'}
          </span>
        )}
        {seabed?.available && (
          <span className="text-[11px] font-mono text-slate-500">
            {fmtNum(seabed.grid.widthM, 0)} × {fmtNum(seabed.grid.lengthM, 0)} m
            {measured && ` · ${fmtNum(seabed.depth?.minM, 1)}–${fmtNum(seabed.depth?.maxM, 1)} m deep`}
            {layout?.lines > 1 && ` · ${layout.lines} lines`}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {scan && (
            <Link to="/app/ai-detection" className="text-[11px] text-slate-500 hover:text-blue-600 flex items-center gap-1">
              <ScanSearch className="w-3.5 h-3.5" />2D detections
            </Link>
          )}
          {seabed?.available && (
            <button type="button" onClick={saveSnapshot}
              className="px-2.5 py-1 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer"
              title="Save the current view (with labels) as a PNG for reports">
              <Camera className="w-3.5 h-3.5" />Snapshot
            </button>
          )}
          {scan && (
            <button type="button" onClick={() => rebuild()} disabled={rebuilding}
              className="px-2.5 py-1 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              title="Re-run the AI on the stored original (rebuilds the 3D model)">
              {rebuilding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}Rebuild
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 grid grid-cols-12 gap-3 min-h-0">
        {/* Viewer */}
        <div className="col-span-12 lg:col-span-8 xl:col-span-9 bg-[#0a1626] border border-slate-300 rounded-lg overflow-hidden relative min-h-[360px] shadow-xs">
          {seabed?.available ? (
            <>
              <SeabedViewer
                ref={viewerRef}
                lines={lines}
                geo={geoMode && georef}
                colorMode={colorMode}
                exaggeration={exaggeration}
                contours={contours}
                coverage={coverage}
                showTrack={showTrack}
                showTargets={showTargets}
                classes={classes}
                includeSuppressed={includeSuppressed}
                tool={tool}
                selectedKey={selectedKey}
                followT={followT}
                onSelect={selectTarget}
                onPointer={setPointer}
                onMeasure={setMeasure}
                onReady={setLayout}
              />
              {/* Toolbar */}
              <div className="absolute top-2 left-2 flex flex-wrap items-center gap-1.5">
                <div className="flex rounded-md overflow-hidden border border-white/15 bg-slate-900/70 backdrop-blur text-[11px] font-semibold">
                  {[['orbit', 'Orbit / select', MousePointer2], ['measure', 'Measure', Ruler]].map(([id, label, Icon]) => (
                    <button key={id} type="button" onClick={() => changeTool(id)} title={label}
                      className={cn('px-2 py-1 flex items-center gap-1 cursor-pointer', tool === id ? 'bg-sky-500 text-white' : 'text-slate-200 hover:bg-white/10')}>
                      <Icon className="w-3.5 h-3.5" />{label}
                    </button>
                  ))}
                </div>
                <div className="flex rounded-md overflow-hidden border border-white/15 bg-slate-900/70 backdrop-blur text-[11px] font-semibold">
                  {VIEWS.map(({ id, label, icon: Icon }) => (
                    <button key={id} type="button" onClick={() => setView(id)} title={`${label} view`}
                      className="px-2 py-1 flex items-center gap-1 text-slate-200 hover:bg-white/10 cursor-pointer">
                      <Icon className="w-3.5 h-3.5" />{label}
                    </button>
                  ))}
                </div>
              </div>
              {tool === 'measure' && (
                <div className="absolute top-11 left-2 text-[11px] text-pink-100 bg-pink-900/60 border border-pink-300/30 rounded px-2 py-1">
                  Click two points on the seabed to measure distance, depth change and slope.
                </div>
              )}

              {/* Fly-through */}
              {seabed.track?.s?.length > 1 && (
                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-slate-900/75 backdrop-blur border border-white/15 rounded-full pl-1.5 pr-3 py-1 text-[11px] text-slate-200 w-[min(420px,80%)]">
                  <button type="button"
                    onClick={() => { if (followT === null || followT >= 1) setFollowT(0); setPlaying((p) => !p); }}
                    className="w-6 h-6 rounded-full bg-amber-400 text-slate-900 flex items-center justify-center cursor-pointer shrink-0"
                    title={playing ? 'Pause' : 'Ride along the survey track'}>
                    {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
                  </button>
                  <Ship className="w-3.5 h-3.5 text-amber-300 shrink-0" />
                  <input type="range" min="0" max="1000" value={Math.round((followT ?? 0) * 1000)}
                    onChange={(e) => { setPlaying(false); setFollowT(Number(e.target.value) / 1000); }}
                    className="flex-1 accent-amber-400" aria-label="Position along the track" />
                  <span className="font-mono w-14 text-right">{fmtNum((followT ?? 0) * seabed.grid.lengthM, 0, ' m')}</span>
                  {followT !== null && (
                    <button type="button" onClick={() => setView('oblique')} className="text-slate-300 hover:text-white cursor-pointer" title="Back to orbit view">
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )}

              {/* Cursor readout */}
              <div className="absolute bottom-12 left-2 bg-slate-900/75 backdrop-blur border border-white/15 rounded-md px-2.5 py-1.5 text-[10.5px] font-mono text-slate-200 leading-relaxed min-w-[200px]">
                <div className="flex items-center gap-1 text-slate-400 mb-0.5"><Crosshair className="w-3 h-3" />CURSOR</div>
                {pointer ? (
                  <>
                    {pointer.s !== undefined && <div>Along {fmtNum(pointer.s, 1, ' m')} · {sideLabel(pointer.u)}</div>}
                    <div>{measured ? 'Depth' : 'Elevation'} {depthText(pointer)}</div>
                    {pointer.lat !== undefined && <div>{fmtLat(pointer.lat, 6)}, {fmtLon(pointer.lon, 6)}</div>}
                  </>
                ) : <div className="text-slate-500">Move over the seabed</div>}
              </div>

              {/* Legend */}
              <div className="absolute bottom-12 right-2 bg-slate-900/75 backdrop-blur border border-white/15 rounded-md px-2.5 py-1.5 text-[10px] font-mono text-slate-300 w-48">
                {colorMode === 'depth' ? (
                  <>
                    <div className="mb-1">{measured ? 'DEPTH (m)' : 'RELATIVE ELEVATION (m)'}</div>
                    <div className="h-2 rounded" style={{ background: DEPTH_GRADIENT }} />
                    <div className="flex justify-between mt-0.5">
                      <span>{fmtNum(measured ? -(layout?.colorRange?.[0] ?? seabed.elevation.minM) : (layout?.colorRange?.[0] ?? seabed.elevation.minM), 1)}</span>
                      <span>{measured ? '≤ ' : '≥ '}{fmtNum(measured ? -(layout?.colorRange?.[1] ?? seabed.elevation.maxM) : (layout?.colorRange?.[1] ?? seabed.elevation.maxM), 1)}</span>
                    </div>
                    {contours && layout?.contour && <div className="text-slate-400">contours every {fmtNum(layout.contour, layout.contour < 1 ? 2 : 0, ' m')}</div>}
                  </>
                ) : colorMode === 'sonar' ? (
                  <>
                    <div className="mb-1">ACOUSTIC BACKSCATTER</div>
                    <div className="h-2 rounded" style={{ background: SONAR_GRADIENT }} />
                    <div className="flex justify-between mt-0.5"><span>weak / shadow</span><span>strong</span></div>
                  </>
                ) : <div>Hillshade: relief only</div>}
                {coverage && <div className="mt-1 flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-rose-500" />no sonar data</div>}
                <div className="mt-1 text-slate-400">Vertical ×{exaggeration}{layout?.geo ? ' · true geometry' : ' · straightened'}</div>
              </div>
            </>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-6 text-slate-300">
              {scanLoading || listLoading ? (
                <><Loader2 className="w-6 h-6 animate-spin" /><span className="text-xs font-mono">Loading…</span></>
              ) : !scan ? (
                <>
                  <Mountain className="w-10 h-10 text-sky-300/70" />
                  <p className="text-sm font-semibold">No analysed scans yet</p>
                  <p className="text-xs text-slate-400 max-w-sm">Analyse a sonar image or an XTF survey line in AI Detection; its 3D seabed appears here.</p>
                  <Link to="/app/ai-detection" className="px-3 py-1.5 rounded-md bg-sky-500 text-white text-xs font-semibold">Go to AI Detection</Link>
                </>
              ) : (
                <>
                  <Mountain className="w-10 h-10 text-sky-300/70" />
                  <p className="text-sm font-semibold">This scan has no 3D model yet</p>
                  <p className="text-xs text-slate-400 max-w-sm">
                    {seabed?.reason ?? 'It was analysed before the 3D module existed.'} Re-analyse it to build the seabed model.
                  </p>
                  <button type="button" onClick={() => rebuild()} disabled={rebuilding}
                    className="px-3 py-1.5 rounded-md bg-sky-500 hover:bg-sky-600 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-60">
                    {rebuilding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}Build 3D model
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Side panel */}
        <div className="col-span-12 lg:col-span-4 xl:col-span-3 flex flex-col gap-3 min-h-0 overflow-y-auto overflow-x-hidden pr-0.5">
          <Card title="Display" icon={Layers}>
            <div className="flex flex-col gap-2.5">
              <Segmented value={colorMode} options={COLOR_MODES} onChange={setColorMode} />
              <Segmented
                value={geoMode && georef ? 'geo' : 'straight'}
                onChange={(v) => setGeoMode(v === 'geo')}
                options={[
                  { id: 'geo', label: 'True geometry', title: georef ? 'Lay the strip on its real (curved) track, north up' : 'Needs a georeferenced scan (lat/lon)', disabled: !georef },
                  { id: 'straight', label: 'Straightened', title: 'Track drawn as a straight line (along-track distance)' },
                ]}
              />
              <label className="flex items-center gap-2 text-[11px]">
                <span className="text-slate-500 shrink-0">Vertical exaggeration</span>
                <input type="range" min="1" max="10" step="0.5" value={exaggeration}
                  onChange={(e) => setExaggeration(Number(e.target.value))} className="flex-1 accent-blue-600" aria-label="Vertical exaggeration" />
                <span className="font-mono font-bold text-blue-600 w-8 text-right">×{exaggeration}</span>
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                <Toggle checked={contours} onChange={setContours} title="Depth contour lines">Contours</Toggle>
                <Toggle checked={coverage} onChange={setCoverage} title="Highlight seabed without sonar data (dropouts, outside the swath)">Coverage gaps</Toggle>
                <Toggle checked={showTrack} onChange={setShowTrack} title="Vehicle path at its altitude">AUV track</Toggle>
                <Toggle checked={showTargets} onChange={setShowTargets}>Targets</Toggle>
                <Toggle checked={includeSuppressed} onChange={setIncludeSuppressed} title="Also show candidates the false-positive filter rejected">Suppressed</Toggle>
                <Toggle checked={withNeighbours} onChange={setWithNeighbours} disabled={!georef || !geoMode || !neighbourCandidates.length}
                  title={neighbourCandidates.length ? 'Show the overlapping survey lines of this mission' : 'No overlapping lines in this mission'}>
                  Neighbour lines{neighbourCandidates.length ? ` (${neighbourCandidates.length})` : ''}
                </Toggle>
              </div>
              {presentClasses.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {presentClasses.map((c) => {
                    const on = !hiddenClasses.includes(c);
                    return (
                      <button key={c} type="button" onClick={() => setHiddenClasses((h) => (on ? [...h, c] : h.filter((x) => x !== c)))}
                        className={cn('px-2 py-0.5 rounded-full text-[10px] font-semibold border flex items-center gap-1 cursor-pointer',
                          on ? 'bg-white text-slate-700 border-slate-300' : 'bg-slate-100 text-slate-400 border-slate-200 line-through')}>
                        <span className="w-2 h-2 rounded-full" style={{ background: classColor(c) }} />{SHORT[c] ?? classLabel(c)}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </Card>

          {scaleUnknown && (
            <div className="flex gap-2 items-start bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-2.5 text-[11px]">
              <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span>The swath width of this image is unknown, so distances and heights use an assumed 100 m swath. Enter the real swath width under <b>Survey geometry</b>.</span>
            </div>
          )}

          {seabed?.available && (
            <Card title={`Targets (${allTargets.filter((t) => t.status === 'confirmed').length})`} icon={Crosshair}>
              <div className="flex flex-col gap-1 max-h-48 overflow-y-auto -mx-1">
                {lines.map((l) => {
                  const list = allTargets.filter((t) => t.line === l && (t.status === 'confirmed' || includeSuppressed));
                  if (!list.length) return null;
                  return (
                    <div key={l.scan.id}>
                      {lines.length > 1 && <div className="px-1.5 pt-1 text-[10px] font-mono text-slate-400 truncate">{l.primary ? 'THIS LINE' : l.scan.name}</div>}
                      {list.map((t) => (
                        <button key={t.key} type="button" onClick={() => selectTarget(t.key)}
                          className={cn('w-full flex items-center gap-2 px-1.5 py-1 rounded text-left cursor-pointer',
                            t.key === selectedKey ? 'bg-blue-50 ring-1 ring-blue-200' : 'hover:bg-slate-50', t.status !== 'confirmed' && 'opacity-60')}>
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: t.color }} />
                          <span className="font-mono text-[10px] text-slate-500 shrink-0">{t.detectionCode}</span>
                          <span className="truncate flex-1">{t.label}</span>
                          <span className="font-mono text-[10px] text-slate-600 shrink-0" title="height (least depth)">
                            {t.heightM != null ? `${t.heightM.toFixed(1)} m` : '—'}{t.leastDepthM != null ? ` · LD ${t.leastDepthM.toFixed(1)}` : ''}
                          </span>
                        </button>
                      ))}
                    </div>
                  );
                })}
                {!allTargets.length && <span className="text-slate-400 px-1.5">No detections in this scan</span>}
              </div>
            </Card>
          )}

          {selected && (
            <Card title={`${selected.detectionCode} · ${classLabel(selected.className)}`} icon={Info}
              right={<button type="button" onClick={() => viewerRef.current?.flyTo(selected.key)} className="text-[10px] font-semibold text-blue-600 hover:underline cursor-pointer shrink-0">Fly to</button>}>
              <SonarCrop scan={selected.line.scan} det={selectedDet} />
              {!selected.line.primary && <Row label="Line">{selected.line.scan.name}</Row>}
              <Row label="Status">{selected.status}{selectedDet ? ` · ${fmtNum(selectedDet.confidence, 1, '%')}` : ''}</Row>
              <Row label="Height" title={seabed.methods?.targets} strong>
                {selected.heightM != null ? `${fmtNum(selected.heightM, 2, ' m')} (shadow)` : 'no measurable shadow'}
              </Row>
              {selected.leastDepthM != null && (
                <Row label="Least depth" title="Shallowest point over the target: the clearance a vessel, anchor or cable must allow" strong>
                  {fmtNum(selected.leastDepthM, 2, ' m')}
                </Row>
              )}
              {selected.seabedDepthM != null && <Row label="Seabed depth">{fmtNum(selected.seabedDepthM, 2, ' m')}</Row>}
              {selectedDet?.dimensions?.shadowLengthM != null && <Row label="Shadow length">{fmtNum(selectedDet.dimensions.shadowLengthM, 2, ' m')}</Row>}
              {selectedDet?.dimensions?.alongTrackM != null && (
                <Row label="Footprint">{fmtNum(selectedDet.dimensions.alongTrackM, 1)} × {fmtNum(selectedDet.dimensions.acrossTrackM, 1, ' m')}</Row>
              )}
              <Row label="Along track / range">{fmtNum(selected.s, 1, ' m')} · {sideLabel(selected.u)}</Row>
              {selectedDet?.location && <Row label="Position">{fmtPoint(selectedDet.location, 6)}</Row>}
              {selectedDet?.geo?.altitudeM != null && <Row label="Sonar altitude">{fmtNum(selectedDet.geo.altitudeM, 1, ' m')}</Row>}
            </Card>
          )}

          {measure && (
            <Card title="Measurement" icon={Ruler}
              right={<button type="button" onClick={() => viewerRef.current?.clearMeasure()} className="text-slate-400 hover:text-red-600 cursor-pointer" title="Clear"><Trash2 className="w-3.5 h-3.5" /></button>}>
              {measure.b ? (
                <>
                  <Row label="Distance (3D)" strong>{fmtNum(measure.distance, 2, ' m')}</Row>
                  <Row label="Horizontal">{fmtNum(measure.horizontal, 2, ' m')}</Row>
                  {measure.bearingDeg != null && <Row label="Bearing A→B">{fmtNum(measure.bearingDeg, 0, '°')}</Row>}
                  {measured ? (
                    <Row label="Depth change (A→B)" title="Positive: B is deeper than A">{`${-measure.dh >= 0 ? '+' : ''}${fmtNum(-measure.dh, 2, ' m')}`}</Row>
                  ) : (
                    <Row label="Height change (A→B)">{`${measure.dh >= 0 ? '+' : ''}${fmtNum(measure.dh, 2, ' m')}`}</Row>
                  )}
                  <Row label="Mean slope">{fmtNum(measure.slopeDeg, 1, '°')}</Row>
                  {measure.reliefM != null && <Row label="Relief along the line">{fmtNum(measure.reliefM, 2, ' m')}</Row>}
                  <Row label="A">{depthText(measure.a)}{measure.a.lat !== undefined ? ` · ${fmtLat(measure.a.lat, 5)} ${fmtLon(measure.a.lon, 5)}` : ''}</Row>
                  <Row label="B">{depthText(measure.b)}{measure.b.lat !== undefined ? ` · ${fmtLat(measure.b.lat, 5)} ${fmtLon(measure.b.lon, 5)}` : ''}</Row>
                  <div className="mt-2"><Profile profile={measure.profile} /></div>
                </>
              ) : <span className="text-slate-500">Point A set ({depthText(measure.a)}). Click a second point.</span>}
            </Card>
          )}

          {seabed?.available && (
            <Card title="Survey geometry & quality" icon={Waypoints}>
              <Row label="Altitude" title={seabed.methods?.altitude}>
                {fmtNum(seabed.altitude?.minM, 1)}–{fmtNum(seabed.altitude?.maxM, 1, ' m')} · {SOURCE_LABEL[seabed.altitude?.source] ?? seabed.altitude?.source ?? '—'}
              </Row>
              {seabed.altitude?.checkM != null && <Row label="Logged vs image">{fmtNum(seabed.altitude.checkM, 2, ' m')} median diff.</Row>}
              <Row label="Across-track scale" title={src.scale}>{src.scale ?? '—'}</Row>
              <Row label="Nadir" title={src.nadir}>{src.nadir ?? '—'}</Row>
              <Row label="Along-track" title={src.along}>{src.along ?? '—'}</Row>
              <Row label="Slant range corrected">{seabed.slantRangeCorrected ? 'yes' : 'no'}</Row>
              {seabed.coverage && (
                <>
                  <Row label="Sonar coverage">{fmtNum((seabed.coverage.coveredFraction ?? 0) * 100, 1, '%')}</Row>
                  {seabed.coverage.dropoutFraction > 0 && <Row label="Dropped pings">{fmtNum(seabed.coverage.dropoutFraction * 100, 1, '%')}</Row>}
                  <Row label="Near-nadir zone" title="Within about one altitude of the track the sonar looks almost straight down and images poorly">
                    {fmtNum(nadirZone, 1, ' m wide')}
                  </Row>
                </>
              )}
              {maxSpacing != null && (
                <div className="mt-2 flex gap-1.5 items-start text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded p-2">
                  {nearest != null && nearest <= maxSpacing
                    ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
                    : <Info className="w-3.5 h-3.5 text-blue-600 shrink-0 mt-0.5" />}
                  <span>
                    Gap-free coverage (including the near-nadir zone) needs survey lines ≤ <b>{fmtNum(maxSpacing, 0, ' m')}</b> apart.
                    {nearest != null && ` Nearest neighbouring line: ${fmtNum(nearest, 0, ' m')}${nearest <= maxSpacing ? ' ✓' : ': consider an infill line'}.`}
                  </span>
                </div>
              )}
              {canCalibrate && (
                <form className="mt-2 flex items-center gap-1.5" onSubmit={(e) => {
                  e.preventDefault();
                  const v = Number(swathInput);
                  if (v > 0) rebuild({ swathWidthM: v });
                }}>
                  <SlidersHorizontal className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                  <input type="number" min="1" step="any" value={swathInput} onChange={(e) => setSwathInput(e.target.value)}
                    placeholder={`Swath width in m (now ${fmtNum(seabed.geometry?.swathM, 0)}${scaleUnknown ? ', assumed' : ''})`}
                    aria-label="Swath width in metres"
                    className="flex-1 min-w-0 bg-white border border-slate-300 rounded px-2 py-1 text-[11px] font-mono" />
                  <button type="submit" disabled={rebuilding || !(Number(swathInput) > 0)}
                    className="px-2 py-1 rounded bg-blue-600 text-white text-[11px] font-semibold disabled:opacity-40 cursor-pointer">Apply</button>
                </form>
              )}
            </Card>
          )}

          {seabed?.available && (
            <Card title="How this model was built" icon={Mountain}>
              <Row label="Depth">{measured ? `${fmtNum(seabed.depth?.minM, 2)}–${fmtNum(seabed.depth?.maxM, 2)} m` : 'relative'}</Row>
              <Row label="Swath × length">{fmtNum(seabed.grid.widthM, 1)} × {fmtNum(seabed.grid.lengthM, 1, ' m')}</Row>
              <Row label="Grid">{seabed.grid.nx} × {seabed.grid.nz} · {fmtNum(seabed.grid.cellXM, 2, ' m')}</Row>
              <Row label="Relief (RMS)">{fmtNum(seabed.relief?.rmsM, 2, ' m')}</Row>
              <ul className="mt-2 flex flex-col gap-1 text-[11px] text-slate-600 list-none">
                <li><b className="text-emerald-700">Depth:</b> {seabed.methods?.depth}</li>
                {seabed.methods?.altitude && <li><b className="text-sky-700">Altitude:</b> {seabed.methods.altitude}</li>}
                <li><b className="text-amber-700">Relief:</b> {seabed.methods?.relief}</li>
                <li><b className="text-blue-700">Targets:</b> {seabed.methods?.targets}</li>
              </ul>
              {seabed.assumptions?.length > 0 && (
                <details className="mt-2 text-[11px] text-slate-500">
                  <summary className="cursor-pointer">Assumptions ({seabed.assumptions.length})</summary>
                  <ul className="mt-1 list-disc pl-4">{seabed.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
                </details>
              )}
              {scan?.georeference?.available && <div className="mt-2 flex items-center gap-1 text-[10px] text-slate-400"><Globe2 className="w-3 h-3" />Positions from {scan.georeference.source?.replace(/_/g, ' ')}</div>}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
