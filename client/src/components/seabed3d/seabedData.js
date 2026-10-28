/**
 * 3D seabed model of a scan (see ai/app/seabed): a heightfield in track coordinates plus a ground-range sonar texture.
 *   s  along-track distance from the first ping (m)
 *   u  ground range from the nadir (m), starboard positive, port negative
 */

const EARTH_RADIUS_M = 6371008.8;

/** Fetch the uint16 heightfield of `scan.seabed` and decode it to metres (Float32Array, row-major nz x nx). */
export async function loadSeabed(seabed, { signal } = {}) {
  const { grid, elevation } = seabed;
  const res = await fetch(elevation.file.url, { signal });
  if (!res.ok) throw new Error(`Heightfield download failed (${res.status})`);
  const buf = await res.arrayBuffer();
  const n = grid.nx * grid.nz;
  if (buf.byteLength < n * 2) throw new Error('Heightfield file is incomplete');
  const view = new DataView(buf);
  const heights = new Float32Array(n);
  for (let i = 0; i < n; i++) heights[i] = view.getUint16(i * 2, true) * elevation.scale + elevation.offset;
  return { ...seabed, heights };
}

/** Bilinear elevation (m) at (s, u); clamps to the strip. */
export function heightAt(model, s, u) {
  const { nx, nz, cellXM, cellZM, widthM } = model.grid;
  const fx = Math.min(Math.max((u + widthM / 2) / cellXM, 0), nx - 1);
  const fz = Math.min(Math.max(s / cellZM, 0), nz - 1);
  const x0 = Math.min(Math.floor(fx), nx - 2);
  const z0 = Math.min(Math.floor(fz), nz - 2);
  const tx = fx - x0;
  const tz = fz - z0;
  const h = model.heights;
  const a = h[z0 * nx + x0] * (1 - tx) + h[z0 * nx + x0 + 1] * tx;
  const b = h[(z0 + 1) * nx + x0] * (1 - tx) + h[(z0 + 1) * nx + x0 + 1] * tx;
  return a * (1 - tz) + b * tz;
}

function sampleTrack(track, key, s) {
  const xs = track.s;
  const ys = track[key];
  if (!ys?.length) return null;
  if (s <= xs[0]) return ys[0];
  if (s >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= s) lo = mid;
    else hi = mid;
  }
  const t = (s - xs[lo]) / (xs[hi] - xs[lo] || 1);
  if (key === 'heading') {                                 // interpolate angles the short way round
    const d = ((ys[hi] - ys[lo] + 540) % 360) - 180;
    return (ys[lo] + d * t + 360) % 360;
  }
  return ys[lo] + (ys[hi] - ys[lo]) * t;
}

/** Vehicle altitude and water depth at along-track distance s (null when unknown). */
export const altitudeAt = (track, s) => sampleTrack(track, 'altitude', s);

/** lat/lon of a seabed point: vehicle position at s, then |u| metres abeam (heading +/- 90 deg). */
export function localToLatLon(track, s, u) {
  const lat = sampleTrack(track, 'lat', s);
  const lon = sampleTrack(track, 'lon', s);
  if (lat === null || lon === null) return null;
  const heading = sampleTrack(track, 'heading', s) ?? 0;
  const bearing = ((heading + (u >= 0 ? 90 : -90)) * Math.PI) / 180;
  const d = Math.abs(u);
  return {
    lat: lat + ((d * Math.cos(bearing)) / EARTH_RADIUS_M) * (180 / Math.PI),
    lon: lon + ((d * Math.sin(bearing)) / (EARTH_RADIUS_M * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI),
  };
}

/** A round contour interval giving roughly `lines` contours over the range. */
export function niceInterval(range, lines = 12) {
  const raw = Math.max(range, 0.01) / lines;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((v) => v >= raw) ?? raw;
}

// ---------------------------------------------------------------- true geometry (lat/lon) and multi-line views

export const hasLatLon = (model) => model?.track?.lat?.length > 1 && model.track.lon?.length === model.track.lat.length;

/**
 * Local east / north frame (metres) around an origin; world axes x = east, z = -north (north points away from a
 * camera looking down -z).
 */
export function makeFrame(lat0, lon0) {
  const ky = (Math.PI / 180) * EARTH_RADIUS_M;
  const kx = ky * Math.cos((lat0 * Math.PI) / 180);
  return {
    lat0,
    lon0,
    toWorld: (lat, lon) => ({ x: (lon - lon0) * kx, z: -(lat - lat0) * ky }),
    toLatLon: (x, z) => ({ lat: lat0 - z / ky, lon: lon0 + x / kx }),
  };
}

/**
 * (s, u) -> world (x, z) for a strip laid along its real track: vehicle position at s, then u metres along the
 * starboard normal of the (lightly smoothed) heading. Rows are precomputed on the heightfield grid.
 */
export function stripMapper(model, frame) {
  const { nz, cellZM } = model.grid;
  const tr = model.track;
  const smooth = Math.max(1, Math.round(tr.s.length / 80));
  const rowE = new Float64Array(nz);
  const rowN = new Float64Array(nz);
  const rowSx = new Float64Array(nz);
  const rowSz = new Float64Array(nz);
  for (let j = 0; j < nz; j++) {
    const s = j * cellZM;
    const p = frame.toWorld(sampleTrack(tr, 'lat', s), sampleTrack(tr, 'lon', s));
    // circular mean of the heading over a short window (yaw jitter would make the swath edges wiggle)
    let cx = 0;
    let cy = 0;
    for (let k = -smooth; k <= smooth; k++) {
      const h = (sampleTrack(tr, 'heading', s + (k * model.grid.lengthM) / tr.s.length) * Math.PI) / 180;
      cx += Math.sin(h);
      cy += Math.cos(h);
    }
    const hdg = Math.atan2(cx, cy);
    rowE[j] = p.x;
    rowN[j] = p.z;
    // starboard = heading + 90 deg; in world coordinates north is -z
    rowSx[j] = Math.sin(hdg + Math.PI / 2);
    rowSz[j] = -Math.cos(hdg + Math.PI / 2);
  }
  return (s, u) => {
    const f = Math.min(Math.max(s / cellZM, 0), nz - 1);
    const j = Math.min(Math.floor(f), nz - 2);
    const t = nz > 1 ? f - j : 0;
    const lerp = (a) => (nz > 1 ? a[j] * (1 - t) + a[j + 1] * t : a[0]);
    return { x: lerp(rowE) + u * lerp(rowSx), z: lerp(rowN) + u * lerp(rowSz) };
  };
}

/** Straightened strip: x = u, z = s - length / 2. */
export const straightMapper = (model) => (s, u) => ({ x: u, z: s - model.grid.lengthM / 2 });

/**
 * World-space elevation grid built by splatting the strips' heightfields (used for picking, measuring and placing
 * markers when the strips are laid on their real, curved tracks; overlapping lines are averaged).
 * strips: [{ positions (x, y, z per vertex), heights (m per vertex), cellM }]
 */
export function buildWorldGrid(strips, maxCells = 2_000_000) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const st of strips) {
    const p = st.positions;
    for (let k = 0; k < p.length; k += 3) {
      if (p[k] < minX) minX = p[k];
      if (p[k] > maxX) maxX = p[k];
      if (p[k + 2] < minZ) minZ = p[k + 2];
      if (p[k + 2] > maxZ) maxZ = p[k + 2];
    }
  }
  const area = (maxX - minX) * (maxZ - minZ);
  const cell = Math.max(Math.min(...strips.map((s) => s.cellM)), Math.sqrt(area / maxCells), 0.05);
  const nx = Math.ceil((maxX - minX) / cell) + 1;
  const nz = Math.ceil((maxZ - minZ) / cell) + 1;
  const sum = new Float32Array(nx * nz);
  const cnt = new Float32Array(nx * nz);
  for (const st of strips) {
    const p = st.positions;
    const h = st.heights;
    for (let k = 0; k < h.length; k++) {
      const i = Math.round((p[k * 3] - minX) / cell);
      const j = Math.round((p[k * 3 + 2] - minZ) / cell);
      sum[j * nx + i] += h[k];
      cnt[j * nx + i] += 1;
    }
  }
  let grid = new Float32Array(nx * nz).fill(NaN);
  for (let k = 0; k < grid.length; k++) if (cnt[k]) grid[k] = sum[k] / cnt[k];
  // fill pin-holes left by the splatting (cells finer than the strip spacing)
  for (let pass = 0; pass < 2; pass++) {
    const next = grid.slice();
    for (let j = 1; j < nz - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const k = j * nx + i;
        if (!Number.isNaN(grid[k])) continue;
        let s = 0;
        let c = 0;
        for (const d of [-1, 1, -nx, nx, -nx - 1, -nx + 1, nx - 1, nx + 1]) {
          if (!Number.isNaN(grid[k + d])) { s += grid[k + d]; c += 1; }
        }
        if (c >= 3) next[k] = s / c;
      }
    }
    grid = next;
  }
  const at = (x, z) => {
    const fx = (x - minX) / cell;
    const fz = (z - minZ) / cell;
    if (fx < 0 || fz < 0 || fx > nx - 1 || fz > nz - 1) return NaN;
    const i = Math.min(Math.floor(fx), nx - 2);
    const j = Math.min(Math.floor(fz), nz - 2);
    const tx = fx - i;
    const tz = fz - j;
    const v = [grid[j * nx + i], grid[j * nx + i + 1], grid[(j + 1) * nx + i], grid[(j + 1) * nx + i + 1]];
    if (v.some(Number.isNaN)) {                      // edge of the coverage: nearest valid corner
      const near = v[(tz > 0.5 ? 2 : 0) + (tx > 0.5 ? 1 : 0)];
      return Number.isNaN(near) ? v.find((q) => !Number.isNaN(q)) ?? NaN : near;
    }
    return (v[0] * (1 - tx) + v[1] * tx) * (1 - tz) + (v[2] * (1 - tx) + v[3] * tx) * tz;
  };
  return { at, bounds: { minX, maxX, minZ, maxZ }, cell };
}

/** A "nice" round length for a scale bar. */
export function niceLength(m) {
  const p = 10 ** Math.floor(Math.log10(Math.max(m, 1e-3)));
  return [1, 2, 5, 10].map((k) => k * p).filter((v) => v <= m).pop() ?? p;
}
