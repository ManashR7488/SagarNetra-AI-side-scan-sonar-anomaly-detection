export const fmtLat = (lat, digits = 5) =>
  lat === undefined || lat === null ? '—' : `${Math.abs(lat).toFixed(digits)}°${lat >= 0 ? 'N' : 'S'}`;

export const fmtLon = (lon, digits = 5) =>
  lon === undefined || lon === null ? '—' : `${Math.abs(lon).toFixed(digits)}°${lon >= 0 ? 'E' : 'W'}`;

/** GeoJSON point -> "13.08436°N, 80.38278°E" */
export const fmtPoint = (point, digits = 5) =>
  point?.coordinates ? `${fmtLat(point.coordinates[1], digits)}, ${fmtLon(point.coordinates[0], digits)}` : '—';

export const fmtNum = (v, digits = 1, unit = '') =>
  v === undefined || v === null || Number.isNaN(v) ? '—' : `${Number(v).toFixed(digits)}${unit}`;

export const fmtPct = (v, digits = 0) => fmtNum(v, digits, '%');

export const fmtBytes = (b) => {
  if (!b && b !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
};

export const fmtMs = (ms) => (ms === undefined || ms === null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

/** Pick the lat/lng out of a detection for the map (null when not geotagged). */
export const detectionLatLng = (d) =>
  d?.location?.coordinates ? { lat: d.location.coordinates[1], lng: d.location.coordinates[0] } : null;
