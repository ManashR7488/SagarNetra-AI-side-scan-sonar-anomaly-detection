import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import { Compass, AlertTriangle, Route, Navigation } from 'lucide-react';
import { classColor, classLabel } from '../utils/classes';

// Distance & bearing calculation helpers
export function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Calculate true bearing (0-360 degrees) between two geographic points
export function calculateBearing(lat1, lon1, lat2, lon2) {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  const theta = Math.atan2(y, x);
  return ((theta * 180) / Math.PI + 360) % 360;
}

// Compute intermediate point along a geodesic line segment
export function getFractionPosition(lat1, lon1, lat2, lon2, fraction = 0.5) {
  return [
    lat1 + (lat2 - lat1) * fraction,
    lon1 + (lon2 - lon1) * fraction,
  ];
}

// Directional navigation arrow marker icon
function createDirectionArrowIcon(bearing, color = '#059669', legNumber) {
  return L.divIcon({
    className: 'cleaning-route-directional-arrow',
    html: `
      <div style="
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        pointer-events: auto;
      ">
        <div style="
          transform: rotate(${bearing}deg);
          display: flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          background: #ffffff;
          border-radius: 50%;
          border: 2px solid ${color};
          box-shadow: 0 2px 5px rgba(0,0,0,0.3);
          transition: transform 0.2s ease;
        ">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path d="M12 3L20 20L12 16.5L4 20L12 3Z" fill="${color}" stroke="#047857" stroke-width="1.5" stroke-linejoin="round"/>
          </svg>
        </div>
        ${legNumber !== undefined ? `
          <div style="
            position: absolute;
            top: -6px;
            right: -6px;
            background: #065f46;
            color: #ffffff;
            font-size: 8px;
            font-weight: 800;
            font-family: monospace;
            padding: 0.5px 3px;
            border-radius: 3px;
            border: 1px solid #ffffff;
            box-shadow: 0 1px 2px rgba(0,0,0,0.25);
          ">
            &rarr;
          </div>
        ` : ''}
      </div>
    `,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

export function computeOptimalCleaningPath(points = [], startPinId) {
  if (!points || points.length <= 1) {
    return {
      orderedPins: points.map((p, idx) => ({ ...p, routeOrder: idx + 1 })),
      totalDistanceKm: 0,
      totalDistanceNm: 0,
      estimatedHours: points && points.length > 0 ? 0.5 : 0,
    };
  }

  const unvisited = [...points];
  const ordered = [];

  // If user selected a specific starting anomaly, pick it first
  if (startPinId && startPinId !== 'auto') {
    const startIdx = unvisited.findIndex(p => p.id === startPinId || `PIN-${p.id}` === startPinId || (p.pingNumber && `PING-${p.pingNumber}` === startPinId));
    if (startIdx !== -1) {
      const current = unvisited.splice(startIdx, 1)[0];
      ordered.push(current);
    } else {
      const current = unvisited.shift();
      ordered.push(current);
    }
  } else {
    // Start with closest to north-west point
    const current = unvisited.shift();
    ordered.push(current);
  }

  let current = ordered[0];

  while (unvisited.length > 0) {
    let nearestIdx = 0;
    let minDistance = Infinity;

    for (let i = 0; i < unvisited.length; i++) {
      const d = haversineDistanceKm(current.lat, current.lng, unvisited[i].lat, unvisited[i].lng);
      if (d < minDistance) {
        minDistance = d;
        nearestIdx = i;
      }
    }

    current = unvisited.splice(nearestIdx, 1)[0];
    ordered.push(current);
  }

  // 2-opt refinement preserving start point at index 0
  let improved = true;
  let iterations = 0;
  while (improved && iterations < 40) {
    improved = false;
    iterations++;
    for (let i = 1; i < ordered.length - 2; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const dCurrent =
          haversineDistanceKm(ordered[i - 1].lat, ordered[i - 1].lng, ordered[i].lat, ordered[i].lng) +
          (j + 1 < ordered.length
            ? haversineDistanceKm(ordered[j].lat, ordered[j].lng, ordered[j + 1].lat, ordered[j + 1].lng)
            : 0);
        const dReversed =
          haversineDistanceKm(ordered[i - 1].lat, ordered[i - 1].lng, ordered[j].lat, ordered[j].lng) +
          (j + 1 < ordered.length
            ? haversineDistanceKm(ordered[i].lat, ordered[i].lng, ordered[j + 1].lat, ordered[j + 1].lng)
            : 0);

        if (dReversed < dCurrent - 0.005) {
          const slice = ordered.slice(i, j + 1).reverse();
          ordered.splice(i, slice.length, ...slice);
          improved = true;
        }
      }
    }
  }

  const numberedPins = ordered.map((p, idx) => ({ ...p, routeOrder: idx + 1 }));

  let totalKm = 0;
  for (let i = 0; i < numberedPins.length - 1; i++) {
    totalKm += haversineDistanceKm(numberedPins[i].lat, numberedPins[i].lng, numberedPins[i + 1].lat, numberedPins[i + 1].lng);
  }

  const totalNm = totalKm * 0.539957;
  const transitHours = totalNm / 4.5;
  const retrievalHours = numberedPins.length * 0.45;
  const estimatedHours = transitHours + retrievalHours;

  return {
    orderedPins: numberedPins,
    totalDistanceKm: Number(totalKm.toFixed(2)),
    totalDistanceNm: Number(totalNm.toFixed(2)),
    estimatedHours: Number(estimatedHours.toFixed(1)),
  };
}

// Marker for a detection: coloured by class, numbered when part of the cleanup route
function createSonarMarkerIcon(color, sequenceNumber, dimmed = false) {
  return L.divIcon({
    className: 'custom-sonar-pin',
    html: `
      <div style="position: relative; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; opacity: ${dimmed ? 0.45 : 1};">
        <div style="position: absolute; width: 100%; height: 100%; border-radius: 50%; background-color: ${color}55;
          ${dimmed ? '' : 'animation: ping 2s cubic-bezier(0, 0, 0.2, 1) infinite;'}"></div>
        <div style="position: relative; width: 24px; height: 24px; border-radius: 50%; background-color: #ffffff;
          border: 2.5px solid ${color}; box-shadow: 0 2px 6px rgba(0,0,0,0.25); display: flex; align-items: center;
          justify-content: center; color: ${color}; font-size: 11px; font-weight: 800; font-family: monospace;">
          ${sequenceNumber !== undefined ? sequenceNumber : '&#9679;'}
        </div>
      </div>
    `,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -17],
  });
}

// Fit the map to the pins when the set of pins changes; fly to the focused location when it changes.
function MapController({ pins, activeLocation }) {
  const map = useMap();
  const pinsKey = pins.map((p) => `${p.id}:${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join('|');

  useEffect(() => {
    if (!pins.length) return;
    map.fitBounds(L.latLngBounds(pins.map((p) => [p.lat, p.lng])), { padding: [40, 40], maxZoom: 16 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinsKey, map]);

  useEffect(() => {
    if (activeLocation) map.setView([activeLocation.lat, activeLocation.lng], Math.max(map.getZoom(), 15), { animate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLocation?.lat, activeLocation?.lng, map]);

  return null;
}

/**
 * Map of geotagged detections.
 * pinnedLocations: [{ id, lat, lng, code, title, className, confidence (0-100), severity, reviewStatus, dimensions, dimmed? }]
 * tracks: optional vehicle tracks [{ id, positions: [[lat, lng], ...], label }]
 */
export default function SonarMap({
  pinnedLocations = [],
  tracks = [],
  activeLocation,
  onSelectPin,
  showCleaningRoute = true,
  onToggleCleaningRoute,
  cleaningRouteData,
}) {
  const defaultCenter = [13.085, 80.395];
  const [internalShowRoute, setInternalShowRoute] = useState(showCleaningRoute);
  const isCleaningRouteActive = onToggleCleaningRoute !== undefined ? showCleaningRoute : internalShowRoute;
  const toggleRoute = (val) => {
    setInternalShowRoute(val);
    onToggleCleaningRoute?.(val);
  };

  const routePlan = cleaningRouteData || computeOptimalCleaningPath(pinnedLocations);
  const cleaningPathPositions = (routePlan.orderedPins || []).map((p) => [p.lat, p.lng]);
  const pinOrderMap = new Map((routePlan.orderedPins || []).map((p, idx) => [p.id, idx + 1]));

  const cleaningRouteArrows = [];
  if (isCleaningRouteActive && routePlan.orderedPins?.length > 1) {
    for (let i = 0; i < routePlan.orderedPins.length - 1; i++) {
      const p1 = routePlan.orderedPins[i];
      const p2 = routePlan.orderedPins[i + 1];
      cleaningRouteArrows.push({
        id: `arrow-${p1.id}-${p2.id}`,
        position: getFractionPosition(p1.lat, p1.lng, p2.lat, p2.lng, 0.5),
        bearing: calculateBearing(p1.lat, p1.lng, p2.lat, p2.lng),
        fromStop: i + 1,
        toStop: i + 2,
        distanceKm: haversineDistanceKm(p1.lat, p1.lng, p2.lat, p2.lng),
      });
    }
  }

  const classesShown = [...new Set(pinnedLocations.map((p) => p.className))];

  return (
    <div className="@container relative w-full h-full rounded-lg overflow-hidden border border-slate-200 bg-white flex flex-col shadow-xs">
      <div className="absolute top-2.5 left-14 z-[1000] bg-white/95 backdrop-blur-md px-3 py-1.5 rounded-md border border-slate-200 shadow-sm hidden @2xl:flex items-center gap-2 text-xs text-slate-800">
        <Compass className="w-3.5 h-3.5 text-blue-600" />
        <span className="font-mono font-bold text-slate-900">GEOTAGGED DETECTIONS</span>
        <span className="text-slate-300">|</span>
        <span className="text-blue-600 font-mono font-bold">{pinnedLocations.length} PINNED</span>
      </div>

      <div className="absolute top-2.5 right-2.5 z-[1000] flex items-center gap-2">
        <button
          type="button"
          onClick={() => toggleRoute(!isCleaningRouteActive)}
          className={`px-2.5 py-1 rounded-md text-[10px] font-mono font-bold border flex items-center gap-1.5 shadow-sm transition-all cursor-pointer ${
            isCleaningRouteActive ? 'bg-emerald-600 text-white border-emerald-700' : 'bg-white/95 text-slate-700 border-slate-300 hover:bg-slate-50'
          }`}
          title={isCleaningRouteActive ? 'Hide the cleanup route' : 'Show the optimal cleanup route'}
        >
          <Route className="w-3.5 h-3.5" />
          <span>{isCleaningRouteActive ? 'CLEANUP ROUTE: ON' : 'CLEANUP ROUTE: OFF'}</span>
        </button>
        <div className="bg-white/95 backdrop-blur-md px-2.5 py-1 rounded-md border border-slate-200 shadow-sm text-[10px] font-mono text-slate-600 font-semibold hidden sm:block">
          WGS-84
        </div>
      </div>

      {isCleaningRouteActive && routePlan.orderedPins.length > 1 && (
        <div className="absolute top-12 left-14 z-[1000] hidden @lg:block bg-white/95 backdrop-blur-md border border-emerald-200 rounded-lg p-2.5 shadow-md text-xs font-mono text-slate-800 max-w-xs">
          <div className="flex items-center gap-1.5 text-emerald-700 font-bold border-b border-emerald-100 pb-1 mb-1.5 text-[11px]">
            <Navigation className="w-3.5 h-3.5" />
            <span>OPTIMAL CLEANUP ROUTE (NN + 2-OPT)</span>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
            <div className="text-slate-500">Waypoints: <strong className="text-slate-900">{routePlan.orderedPins.length}</strong></div>
            <div className="text-slate-500">Est. time: <strong className="text-emerald-700">{routePlan.estimatedHours} h</strong></div>
            <div className="text-slate-500">Distance: <strong className="text-slate-900">{routePlan.totalDistanceNm} NM</strong></div>
            <div className="text-slate-500">Metric: <strong className="text-slate-900">{routePlan.totalDistanceKm} km</strong></div>
          </div>
        </div>
      )}

      <MapContainer center={defaultCenter} zoom={12} className="w-full h-full" style={{ background: '#dbeafe' }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={19}
        />

        {tracks.map((t) => (
          <Polyline key={t.id} positions={t.positions} pathOptions={{ color: '#2563eb', weight: 2.5, dashArray: '5, 8', opacity: 0.8 }}>
            {t.label && <Popup><div className="font-mono text-[10px]">Vehicle track: {t.label}</div></Popup>}
          </Polyline>
        ))}

        {isCleaningRouteActive && cleaningPathPositions.length > 1 && (
          <Polyline positions={cleaningPathPositions} pathOptions={{ color: '#059669', weight: 3.5, opacity: 0.9, dashArray: '8, 6' }} />
        )}

        {isCleaningRouteActive && cleaningRouteArrows.map((arrow) => (
          <Marker key={arrow.id} position={arrow.position} icon={createDirectionArrowIcon(arrow.bearing, '#059669', arrow.toStop)}>
            <Popup>
              <div className="p-1 text-slate-800 font-mono text-[10px]">
                <div className="font-bold text-emerald-700 border-b border-slate-200 pb-1 mb-1">Leg: stop #{arrow.fromStop} &rarr; #{arrow.toStop}</div>
                <div>Heading: <strong>{arrow.bearing.toFixed(1)}° true</strong></div>
                <div>Distance: <strong>{(arrow.distanceKm * 1000).toFixed(0)} m ({(arrow.distanceKm * 0.539957).toFixed(3)} NM)</strong></div>
              </div>
            </Popup>
          </Marker>
        ))}

        {pinnedLocations.map((pin) => {
          const sequenceNumber = isCleaningRouteActive ? pinOrderMap.get(pin.id) : undefined;
          return (
            <Marker
              key={pin.id}
              position={[pin.lat, pin.lng]}
              icon={createSonarMarkerIcon(classColor(pin.className), sequenceNumber, pin.dimmed)}
              eventHandlers={{ click: () => onSelectPin?.(pin) }}
            >
              <Popup>
                <div className="p-1.5 min-w-[230px] text-slate-900 font-sans">
                  <div className="flex items-center justify-between border-b border-slate-200 pb-1.5 mb-1.5 gap-2">
                    <span className="font-bold text-xs flex items-center gap-1" style={{ color: classColor(pin.className) }}>
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      {classLabel(pin.className)}
                    </span>
                    <span className="text-[10px] font-mono bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded font-bold border border-blue-200">
                      {pin.confidence.toFixed(1)}%
                    </span>
                  </div>
                  {sequenceNumber !== undefined && (
                    <div className="bg-emerald-50 border border-emerald-200 rounded p-1 mb-1.5 text-[10px] font-mono text-emerald-800 font-semibold flex justify-between">
                      <span>Cleanup waypoint</span>
                      <span>Stop #{sequenceNumber} of {routePlan.orderedPins.length}</span>
                    </div>
                  )}
                  <div className="text-[11px] space-y-0.5 font-mono text-slate-600">
                    <div className="flex justify-between gap-3"><span className="text-slate-400">ID</span><span className="text-slate-800">{pin.code}</span></div>
                    <div className="flex justify-between gap-3"><span className="text-slate-400">Scan</span><span className="text-slate-800 truncate max-w-[140px]">{pin.title}</span></div>
                    <div className="flex justify-between gap-3"><span className="text-slate-400">Position</span><span className="text-slate-800">{pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}</span></div>
                    {pin.dimensions && (
                      <div className="flex justify-between gap-3">
                        <span className="text-slate-400">Size</span>
                        <span className="text-slate-800">{pin.dimensions.alongTrackM?.toFixed(1)} × {pin.dimensions.acrossTrackM?.toFixed(1)} m</span>
                      </div>
                    )}
                    <div className="flex justify-between gap-3"><span className="text-slate-400">Severity</span><span className="text-slate-800 capitalize">{pin.severity}</span></div>
                    {pin.reviewStatus && (
                      <div className="flex justify-between gap-3"><span className="text-slate-400">Review</span><span className="text-slate-800">{pin.reviewStatus.replace('_', ' ')}</span></div>
                    )}
                  </div>
                </div>
              </Popup>
            </Marker>
          );
        })}

        <MapController pins={pinnedLocations} activeLocation={activeLocation} />
      </MapContainer>

      {(classesShown.length > 0 || tracks.length > 0) && (
        <div className="absolute bottom-2.5 left-2.5 z-[1000] bg-white/95 backdrop-blur-sm border border-slate-200 shadow-sm rounded-md px-3 py-1.5 text-[10px] text-slate-600 flex flex-wrap items-center gap-x-3 gap-y-1 max-w-[70%]">
          {classesShown.map((c) => (
            <div key={c} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: classColor(c) }} />
              <span className="font-medium">{classLabel(c)}</span>
            </div>
          ))}
          {tracks.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="w-3 border-t-2 border-dashed border-blue-600 inline-block" />
              <span className="font-medium">Vehicle track</span>
            </div>
          )}
          {isCleaningRouteActive && (
            <div className="flex items-center gap-1.5">
              <span className="w-3 border-t-2 border-dashed border-emerald-600 inline-block" />
              <span className="font-semibold text-emerald-700">Cleanup route</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
