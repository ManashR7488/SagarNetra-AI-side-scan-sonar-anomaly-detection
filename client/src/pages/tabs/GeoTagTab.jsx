import { useEffect, useMemo, useState } from 'react';
import {
  Download, AlertTriangle, CheckCircle2, Route, Navigation, Anchor, Filter, Loader2, RefreshCw, MapPin, XCircle, Wrench, ShieldCheck,
} from 'lucide-react';
import { cn } from '../../utils/cn';
import SonarMap, { computeOptimalCleaningPath } from '../../components/SonarMap';
import DetectionViewer from '../../components/DetectionViewer';
import { detectionsApi, downloadUrl } from '../../api';
import { useGeoStore } from '../../store/useGeoStore';
import { useMissionStore } from '../../store/useMissionStore';
import { CLASS_NAMES, REVIEW_META, REVIEW_STATUSES, SEVERITY_META, classColor, classLabel } from '../../utils/classes';
import { downloadFromUrl, downloadJson } from '../../utils/download';
import { detectionLatLng, fmtNum, fmtPoint } from '../../utils/format';
import { scanPreviewUrl } from '../../store/useWorkspaceStore';

const OUT_OF_ROUTE = new Set(['false_positive', 'cleared']);

const REVIEW_ACTIONS = [
  { status: 'verified', label: 'Verify', icon: ShieldCheck, className: 'text-emerald-700 hover:bg-emerald-50 border-emerald-200' },
  { status: 'cleanup_scheduled', label: 'Schedule cleanup', icon: Wrench, className: 'text-blue-700 hover:bg-blue-50 border-blue-200' },
  { status: 'cleared', label: 'Cleared', icon: CheckCircle2, className: 'text-teal-700 hover:bg-teal-50 border-teal-200' },
  { status: 'false_positive', label: 'False positive', icon: XCircle, className: 'text-slate-600 hover:bg-slate-100 border-slate-300' },
];

function Chip({ active, onClick, color, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('px-2 py-0.5 rounded-full text-[10px] font-semibold border transition-colors cursor-pointer flex items-center gap-1',
        active ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50')}
    >
      {color && <span className="w-2 h-2 rounded-full" style={{ background: color }} />}
      {children}
    </button>
  );
}

export default function GeoTagTab() {
  const activeMissionId = useMissionStore((s) => s.activeMissionId);
  const dataVersion = useMissionStore((s) => s.dataVersion);
  const activeMission = useMissionStore((s) => s.missions.find((m) => m.id === s.activeMissionId));
  const filters = useGeoStore((s) => s.filters);
  const detections = useGeoStore((s) => s.detections);
  const loading = useGeoStore((s) => s.loading);
  const error = useGeoStore((s) => s.error);
  const selectedId = useGeoStore((s) => s.selectedId);
  const startPointId = useGeoStore((s) => s.startPointId);
  const showRoute = useGeoStore((s) => s.showRoute);
  const excludeCleared = useGeoStore((s) => s.excludeCleared);
  const { setFilters, fetch, select, setStartPoint, setShowRoute, setExcludeCleared, review } = useGeoStore.getState();

  const [focused, setFocused] = useState(null);
  const [detail, setDetail] = useState(null);       // selected detection with its scan (image, frame size)
  const [detailLoading, setDetailLoading] = useState(false);

  const filtersKey = JSON.stringify(filters);
  useEffect(() => {
    fetch(activeMissionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMissionId, filtersKey, dataVersion]);

  const selected = detections.find((d) => d.id === selectedId) ?? null;

  // Load the selected detection's scan image for the close-up view.
  useEffect(() => {
    if (!selectedId) return setDetail(null);
    let cancelled = false;
    setDetailLoading(true);
    detectionsApi.get(selectedId)
      .then((d) => !cancelled && setDetail(d))
      .catch(() => !cancelled && setDetail(null))
      .finally(() => !cancelled && setDetailLoading(false));
    return () => { cancelled = true; };
  }, [selectedId]);

  const pins = useMemo(() => detections.map((d) => ({
    ...detectionLatLng(d),
    id: d.id,
    code: d.code,
    title: d.scan?.name ?? '',
    className: d.className,
    confidence: d.confidence,
    severity: d.severity,
    reviewStatus: d.review?.status,
    dimensions: d.dimensions,
    dimmed: OUT_OF_ROUTE.has(d.review?.status),
  })), [detections]);

  const routePins = useMemo(
    () => (excludeCleared ? pins.filter((p) => !OUT_OF_ROUTE.has(p.reviewStatus)) : pins),
    [pins, excludeCleared],
  );
  const plan = useMemo(() => computeOptimalCleaningPath(routePins, startPointId), [routePins, startPointId]);

  const toggleIn = (key, value) => {
    const list = filters[key];
    setFilters({ [key]: list.includes(value) ? list.filter((v) => v !== value) : [...list, value] });
  };

  const focusDetection = (d) => {
    select(d.id);
    const ll = detectionLatLng(d);
    if (ll) setFocused({ ...ll });
  };

  const exportParams = { missionId: activeMissionId ?? undefined, hasLocation: true, ...filters, hazardOnly: filters.hazardOnly || undefined, minConfidence: filters.minConfidence || undefined };

  const downloadPlan = () => downloadJson({
    project: 'SagarNetra: AI-powered marine debris & anomaly detection (PS 26057, MoES / NIOT)',
    mission: activeMission?.name ?? 'All missions',
    exportedAt: new Date().toISOString(),
    route: {
      algorithm: 'nearest neighbour + 2-opt',
      totalDistanceKm: plan.totalDistanceKm,
      totalDistanceNm: plan.totalDistanceNm,
      estimatedHours: plan.estimatedHours,
      assumptions: 'transit 4.5 kn, 0.45 h per retrieval',
      stops: plan.orderedPins.map((p, i) => ({
        stop: i + 1, detectionId: p.id, code: p.code, className: p.className, severity: p.severity,
        confidencePct: p.confidence, latitude: p.lat, longitude: p.lng, dimensions: p.dimensions, reviewStatus: p.reviewStatus, scan: p.title,
      })),
    },
  }, `cleanup_plan_${(activeMission?.name ?? 'all').replace(/\W+/g, '_')}_${Date.now()}.json`);

  return (
    <div className="flex flex-col h-full bg-slate-100 text-slate-900 p-3 gap-3 overflow-hidden select-none font-sans relative">
      {/* Filters */}
      <div className="flex items-center gap-3 border border-slate-200 bg-white rounded-lg px-3 py-2 shrink-0 shadow-xs flex-wrap">
        <div className="flex items-center gap-1.5 text-xs font-mono font-bold text-slate-600">
          <Filter className="w-3.5 h-3.5 text-blue-600" />FILTER:
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {CLASS_NAMES.map((c) => (
            <Chip key={c} active={filters.className.includes(c)} color={classColor(c)} onClick={() => toggleIn('className', c)}>{classLabel(c)}</Chip>
          ))}
        </div>
        <div className="h-4 w-px bg-slate-200" />
        <div className="flex items-center gap-1">
          {['critical', 'high', 'medium'].map((s) => (
            <Chip key={s} active={filters.severity.includes(s)} onClick={() => toggleIn('severity', s)}>{SEVERITY_META[s].label}</Chip>
          ))}
        </div>
        <div className="h-4 w-px bg-slate-200" />
        <select
          value={filters.reviewStatus[0] ?? ''}
          onChange={(e) => setFilters({ reviewStatus: e.target.value ? [e.target.value] : [] })}
          className="bg-slate-50 border border-slate-300 rounded-md px-2 py-0.5 text-[11px] font-mono cursor-pointer"
        >
          <option value="">Any review status</option>
          {REVIEW_STATUSES.map((s) => <option key={s} value={s}>{REVIEW_META[s].label}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-[11px] font-mono text-slate-600">
          Min conf
          <input type="range" min="0" max="100" step="5" value={filters.minConfidence} onChange={(e) => setFilters({ minConfidence: Number(e.target.value) })} className="accent-blue-600 w-20" />
          <span className="font-bold text-blue-600 w-8">{filters.minConfidence}%</span>
        </label>
        <label className="flex items-center gap-1 text-[11px] font-mono text-slate-600 cursor-pointer">
          <input type="checkbox" checked={filters.hazardOnly} onChange={(e) => setFilters({ hazardOnly: e.target.checked })} className="accent-blue-600" />Hazards only
        </label>
        <label className="flex items-center gap-1 text-[11px] font-mono text-slate-600 cursor-pointer" title="Include AI-suppressed candidates (false-positive filter)">
          <input type="checkbox" checked={filters.status !== 'confirmed'} onChange={(e) => setFilters({ status: e.target.checked ? undefined : 'confirmed' })} className="accent-blue-600" />Suppressed too
        </label>
        <button type="button" onClick={() => fetch(activeMissionId)} className="ml-auto p-1.5 rounded-md text-slate-500 hover:bg-slate-100 hover:text-blue-600 cursor-pointer" title="Refresh">
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-white border border-slate-200 px-3 py-2 rounded-lg shrink-0 shadow-xs">
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className="text-xs font-mono text-slate-600">
            <strong className="text-slate-900">{detections.length}</strong> geotagged detections · {activeMission?.name ?? 'All missions'}
          </span>
          <div className="flex items-center rounded-md border border-slate-300 overflow-hidden shadow-2xs text-xs">
            <span className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-100 font-semibold"><Download className="w-3.5 h-3.5 text-emerald-600" />Export</span>
            <button type="button" onClick={() => downloadFromUrl(downloadUrl('/detections/export.csv', exportParams))} className="px-2 py-1.5 font-mono font-bold border-l border-slate-300 hover:bg-slate-50 cursor-pointer">CSV</button>
            <button type="button" onClick={async () => downloadJson(await detectionsApi.geojson(exportParams), `detections_${Date.now()}.geojson`)} className="px-2 py-1.5 font-mono font-bold border-l border-slate-300 hover:bg-slate-50 cursor-pointer">GEOJSON</button>
            <button type="button" disabled={!plan.orderedPins.length} onClick={downloadPlan} className="px-2 py-1.5 font-mono font-bold border-l border-slate-300 hover:bg-slate-50 cursor-pointer disabled:opacity-40">CLEANUP PLAN</button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1 text-[11px] font-mono text-slate-600 cursor-pointer" title="Leave cleared and false-positive targets out of the route">
            <input type="checkbox" checked={excludeCleared} onChange={(e) => setExcludeCleared(e.target.checked)} className="accent-emerald-600" />Skip cleared / false positives
          </label>
          <button
            type="button"
            onClick={() => setShowRoute(!showRoute)}
            className={cn('flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold border transition-all cursor-pointer',
              showRoute ? 'bg-emerald-50 text-emerald-700 border-emerald-300' : 'bg-slate-50 text-slate-600 border-slate-300')}
          >
            <Route className="w-3.5 h-3.5" />
            <span>Optimal Route: <strong>{showRoute ? 'ON' : 'OFF'}</strong></span>
          </button>
          <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-300 rounded-md px-2.5 py-1 text-xs font-mono shadow-2xs">
            <Anchor className="w-3.5 h-3.5 text-blue-600 shrink-0" />
            <span className="text-slate-600 font-semibold hidden md:inline">Start:</span>
            <select value={startPointId} onChange={(e) => setStartPoint(e.target.value)} className="bg-transparent border-0 text-slate-800 text-xs font-mono focus:outline-none cursor-pointer max-w-[220px] truncate">
              <option value="auto">Auto (first detection)</option>
              {routePins.map((p) => <option key={p.id} value={p.id}>{p.code} · {classLabel(p.className)} · {p.title}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="flex-1 grid grid-cols-12 gap-3 min-h-0">
        {/* Left: selected detection close-up + detection list with review actions */}
        <div className="col-span-6 flex flex-col gap-3 min-h-0">
          <div className="flex-[3] bg-white border border-slate-200 rounded-lg overflow-hidden flex flex-col relative shadow-xs min-h-0">
            <div className="bg-slate-50 border-b border-slate-200 px-3 py-2 flex justify-between items-center text-xs shrink-0 gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2 h-2 rounded-full bg-blue-600 shrink-0" />
                <span className="font-mono font-bold text-slate-900 uppercase tracking-wide truncate">
                  {selected ? `${selected.code} • ${selected.scan?.name ?? ''}` : 'SELECT A DETECTION'}
                </span>
              </div>
              {selected && (
                <span className="text-[11px] font-mono border px-2 py-0.5 rounded font-bold flex items-center gap-1 shrink-0" style={{ color: classColor(selected.className), borderColor: classColor(selected.className) }}>
                  <AlertTriangle className="w-3 h-3" />{classLabel(selected.className)} ({selected.confidence.toFixed(1)}%)
                </span>
              )}
            </div>
            <div className="flex-1 relative bg-slate-950 overflow-hidden min-h-0">
              <div className="absolute inset-2">
                {detail ? (
                  <DetectionViewer
                    imageUrl={scanPreviewUrl(detail.scan)}
                    frame={detail.scan?.source ? { width: detail.scan.source.width, height: detail.scan.source.height } : null}
                    detections={[detail]}
                    selectedId={detail.id}
                    showSuppressed
                    loading={detailLoading}
                  />
                ) : (
                  <div className="h-full flex items-center justify-center text-xs font-mono text-slate-500">
                    {detailLoading ? <Loader2 className="w-6 h-6 animate-spin text-white" /> : 'Click a detection in the list or on the map'}
                  </div>
                )}
              </div>
            </div>
            {selected && (
              <div className="bg-slate-50 border-t border-slate-200 px-3 py-1.5 flex items-center justify-between text-[11px] font-mono text-slate-600 shrink-0 gap-2">
                <span>POS: <strong className="text-slate-900">{fmtPoint(selected.location)}</strong></span>
                <span>SIZE: <strong className="text-blue-600">{selected.dimensions ? `${fmtNum(selected.dimensions.alongTrackM)} × ${fmtNum(selected.dimensions.acrossTrackM)} m` : '—'}</strong></span>
                <div className="flex items-center gap-1">
                  {REVIEW_ACTIONS.map(({ status, label, icon: Icon, className }) => (
                    <button
                      key={status}
                      type="button"
                      onClick={() => review(selected.id, status)}
                      title={label}
                      className={cn('px-1.5 py-0.5 rounded border bg-white text-[10px] font-semibold flex items-center gap-1 cursor-pointer', className,
                        selected.review?.status === status && 'ring-1 ring-offset-1 ring-blue-500')}
                    >
                      <Icon className="w-3 h-3" /><span className="hidden xl:inline">{label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="flex-[2] bg-white border border-slate-200 rounded-lg overflow-hidden flex flex-col shadow-xs min-h-0">
            <div className="bg-slate-50 border-b border-slate-200 px-3 py-1.5 flex justify-between items-center text-xs shrink-0">
              <span className="font-mono font-bold text-slate-900 uppercase tracking-wide">DETECTIONS ({detections.length})</span>
              {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" />}
            </div>
            <div className="flex-1 overflow-y-auto min-h-0">
              {error ? (
                <div className="h-full flex items-center justify-center p-4 text-red-600 text-xs font-mono text-center">{error}</div>
              ) : detections.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center p-4 text-slate-400 text-xs text-center font-mono gap-1">
                  <MapPin className="w-6 h-6 text-slate-300" />
                  No geotagged detections match. Analyse georeferenced scans in the AI Detection tab.
                </div>
              ) : (
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-100/80 text-slate-600 font-mono text-[10px] sticky top-0 border-b border-slate-200 z-10">
                    <tr>
                      <th className="py-1.5 px-3">ID</th>
                      <th className="py-1.5 px-2">CLASS</th>
                      <th className="py-1.5 px-2">SCAN</th>
                      <th className="py-1.5 px-2 text-right">CONF</th>
                      <th className="py-1.5 px-2">SEVERITY</th>
                      <th className="py-1.5 px-2">REVIEW</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                    {detections.map((d) => (
                      <tr key={d.id} onClick={() => focusDetection(d)} className={cn('cursor-pointer transition-colors hover:bg-blue-50/60', d.id === selectedId && 'bg-blue-50/80 font-bold')}>
                        <td className="py-1.5 px-3">{d.code}</td>
                        <td className="py-1.5 px-2 font-sans">
                          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full shrink-0" style={{ background: classColor(d.className) }} />{classLabel(d.className)}</span>
                        </td>
                        <td className="py-1.5 px-2 text-slate-500 truncate max-w-[140px]" title={d.scan?.name}>{d.scan?.name}</td>
                        <td className="py-1.5 px-2 text-right">{d.confidence.toFixed(0)}%</td>
                        <td className="py-1.5 px-2"><span className={cn('px-1 rounded border text-[10px]', SEVERITY_META[d.severity]?.badge)}>{SEVERITY_META[d.severity]?.label}</span></td>
                        <td className="py-1.5 px-2"><span className={cn('px-1 rounded border text-[10px]', REVIEW_META[d.review?.status]?.badge)}>{REVIEW_META[d.review?.status]?.label}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

        {/* Right: map + cleanup route manifest */}
        <div className="col-span-6 flex flex-col gap-3 min-h-0">
          <div className="flex-[3] min-h-0 flex flex-col relative rounded-lg overflow-hidden border border-slate-200 shadow-xs bg-white">
            <SonarMap
              pinnedLocations={pins}
              activeLocation={focused}
              showCleaningRoute={showRoute}
              onToggleCleaningRoute={setShowRoute}
              cleaningRouteData={plan}
              onSelectPin={(pin) => select(pin.id)}
            />
          </div>

          <div className="flex-[2] bg-white border border-slate-200 rounded-lg overflow-hidden flex flex-col shadow-xs min-h-0">
            <div className="bg-slate-50 border-b border-slate-200 px-3 py-1.5 flex justify-between items-center text-xs shrink-0">
              <div className="flex items-center gap-2">
                <Navigation className="w-3.5 h-3.5 text-emerald-600" />
                <span className="font-mono font-bold text-slate-900 uppercase tracking-wide">CLEANUP ROUTE MANIFEST ({plan.orderedPins.length} STOPS)</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] font-mono">
                <span className="text-slate-600">TOTAL: <strong className="text-slate-900">{plan.totalDistanceNm} NM</strong> ({plan.totalDistanceKm} km)</span>
                <span className="text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded font-bold" title="Transit at 4.5 kn + 0.45 h per retrieval">EST. {plan.estimatedHours} H</span>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0">
              {plan.orderedPins.length === 0 ? (
                <div className="h-full flex items-center justify-center p-4 text-slate-400 text-xs text-center font-mono">No targets for the route.</div>
              ) : (
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-100/80 text-slate-600 font-mono text-[10px] sticky top-0 border-b border-slate-200 z-10">
                    <tr>
                      <th className="py-1.5 px-3">STOP</th>
                      <th className="py-1.5 px-2">TARGET</th>
                      <th className="py-1.5 px-2">GPS (WGS-84)</th>
                      <th className="py-1.5 px-2">SIZE</th>
                      <th className="py-1.5 px-2 text-right">ACTION</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                    {plan.orderedPins.map((pin, idx) => (
                      <tr key={pin.id} onClick={() => { select(pin.id); setFocused({ lat: pin.lat, lng: pin.lng }); }}
                        className={cn('cursor-pointer transition-colors hover:bg-blue-50/60', pin.id === selectedId ? 'bg-blue-50/80 font-bold' : idx % 2 ? 'bg-slate-50/40' : 'bg-white')}>
                        <td className="py-1.5 px-3"><span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">#{idx + 1}</span></td>
                        <td className="py-1.5 px-2 font-sans font-medium text-slate-800">
                          <span className="flex items-center gap-1.5 truncate max-w-[170px]"><span className="w-2 h-2 rounded-full shrink-0" style={{ background: classColor(pin.className) }} />{pin.code} {classLabel(pin.className)}</span>
                        </td>
                        <td className="py-1.5 px-2 text-slate-600">{pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}</td>
                        <td className="py-1.5 px-2 text-blue-600 font-semibold">{pin.dimensions ? `${fmtNum(pin.dimensions.alongTrackM, 0)}×${fmtNum(pin.dimensions.acrossTrackM, 0)} m` : '—'}</td>
                        <td className="py-1.5 px-2 text-right"><span className="text-[10px] text-blue-600 font-semibold">Focus</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
