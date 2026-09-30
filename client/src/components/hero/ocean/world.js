/**
 * The procedural survey site and a small side-scan sonar simulator.
 *
 * The sonar image is not painted by hand: every 3D model on the seabed is rasterised top-down into a height
 * field, and each ping line is then simulated from the transducer's point of view (TVG-normalised Lambert
 * backscatter, ray-marched acoustic shadows, Rayleigh speckle). A wreck's return and shadow therefore match
 * the mesh the viewer sees.
 */
import { Matrix4, Vector3 } from 'three';
import { SURVEY, TARGETS } from '../storyline';
import { clamp01, createNoise2D, fbm, mulberry32, smoothstep } from './noise';

export const SEABED = { minX: -100, maxX: 100, minZ: -240, maxZ: 120, step: 1 };
export const RIPPLE = { amp: 0.07, k: 2.6, dirX: 0.33, dirZ: 0.944 };

const random = mulberry32(26057);
const nBroad = createNoise2D(random);
const nMid = createNoise2D(random);
const nMask = createNoise2D(random);
const nAlbedo = createNoise2D(random);

export function terrainHeight(x, z) {
  return fbm(nBroad, x / 75, z / 75, 4) * 1.7 + fbm(nMid, x / 16, z / 16, 3) * 0.3 + x * 0.004;
}

/** Where sand ripples form (0..1). Mirrored in the seabed shader through the detail texture. */
export const rippleMask = (x, z) => smoothstep(-0.2, 0.35, fbm(nMask, x / 45, z / 45, 2));

/** Ripple crest pattern in [-1, 1]; the GLSL twin lives in materials.js. */
export function rippleWave(x, z) {
  const warp = 2 * Math.sin(0.05 * x + 2 * Math.sin(0.03 * z)) + 1.2 * Math.sin(0.07 * z + 1.3);
  return Math.sin(RIPPLE.k * (RIPPLE.dirX * x + RIPPLE.dirZ * z) + warp);
}

export const albedoNoise = (x, z) => 0.5 + 0.5 * fbm(nAlbedo, x / 9, z / 9, 3);

/** The vehicle holds its altitude over a smoothed seabed, like a real altitude controller. */
export function seabedUnderTrack(z) {
  let s = 0;
  for (let k = -2; k <= 2; k++) s += terrainHeight(0, z + k * 5);
  return s / 5;
}
export const vehicleY = (z) => seabedUnderTrack(z) + SURVEY.altitude;
export const transducerY = (z) => vehicleY(z) - 0.3;

// ---------------------------------------------------------------------------------------------- grids

export class Grid {
  constructor(minX, minZ, step, nx, nz, fill = 0) {
    Object.assign(this, { minX, minZ, step, nx, nz });
    this.data = new Float32Array(nx * nz).fill(fill);
  }
}

/**
 * Seabed fields on the mesh's 1 m vertex grid, shared by the mesh, the detail texture and the sonar:
 * height, sediment tone and where sand ripples form. Smooth fields, so finer consumers interpolate.
 */
export function buildSeabedFields() {
  const { minX, maxX, minZ, maxZ, step } = SEABED;
  const nx = Math.round((maxX - minX) / step) + 1;
  const nz = Math.round((maxZ - minZ) / step) + 1;
  const heights = new Grid(minX, minZ, step, nx, nz);
  const albedo = new Grid(minX, minZ, step, nx, nz);
  const ripples = new Grid(minX, minZ, step, nx, nz);
  for (let j = 0; j < nz; j++) {
    const z = minZ + j * step;
    for (let i = 0; i < nx; i++) {
      const x = minX + i * step;
      const k = j * nx + i;
      heights.data[k] = terrainHeight(x, z);
      albedo.data[k] = albedoNoise(x, z);
      ripples.data[k] = rippleMask(x, z);
    }
  }
  return { heights, heightAt: bilinear(heights), albedoAt: bilinear(albedo), rippleAt: bilinear(ripples) };
}

export function bilinear(grid) {
  const { minX, minZ, step, nx, nz, data } = grid;
  return (x, z) => {
    const fx = Math.min(Math.max((x - minX) / step, 0), nx - 1.0001);
    const fz = Math.min(Math.max((z - minZ) / step, 0), nz - 1.0001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const ax = fx - i;
    const az = fz - j;
    const k = j * nx + i;
    const top = data[k] + (data[k + 1] - data[k]) * ax;
    const bottom = data[k + nx] + (data[k + nx + 1] - data[k + nx]) * ax;
    return top + (bottom - top) * az;
  };
}

// ---------------------------------------------------------------------------------------------- rocks

export function scatterRocks() {
  const rnd = mulberry32(4242);
  const solid = TARGETS.filter((t) => t.kind !== 'fish' && t.kind !== 'rocks');
  const rocks = [];
  let guard = 0;
  while (rocks.length < 110 && guard++ < 6000) {
    const x = (rnd() * 2 - 1) * 62;
    const z = -232 + rnd() * 340;
    if (solid.some((t) => Math.hypot(t.x - x, t.z - z) < Math.max(...t.dims) / 2 + 3)) continue;
    const big = rnd() < 0.12;
    rocks.push({
      x, z,
      r: big ? 0.9 + rnd() * 0.9 : 0.16 + rnd() * rnd() * 0.65,
      flat: 0.45 + rnd() * 0.35,
      rot: rnd() * Math.PI * 2,
      tilt: (rnd() - 0.5) * 0.5,
      variant: Math.floor(rnd() * 3),
    });
  }
  // The outcrop the model is expected to reject as a natural feature.
  const o = TARGETS.find((t) => t.kind === 'rocks');
  const cluster = [[0, 0, 2.1], [2.5, 1.2, 1.4], [-2.3, -0.5, 1.5], [0.9, -2.1, 1.1], [-1, 2.2, 0.9], [3.5, -1.3, 0.7], [-3.4, 1.6, 0.6]];
  for (const [dx, dz, r] of cluster) {
    rocks.push({ x: o.x + dx, z: o.z + dz, r, flat: 0.72, rot: rnd() * Math.PI * 2, tilt: (rnd() - 0.5) * 0.3, variant: Math.floor(rnd() * 3) });
  }
  return rocks;
}

// ---------------------------------------------------------------------------------------------- rasteriser

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _m = new Matrix4();

function rasterTriangle(a, b, c, grid, ids, id) {
  const { minX, minZ, step, nx, nz, data } = grid;
  const area = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
  if (Math.abs(area) < 1e-8) return;
  const i0 = Math.max(0, Math.ceil((Math.min(a.x, b.x, c.x) - minX) / step));
  const i1 = Math.min(nx - 1, Math.floor((Math.max(a.x, b.x, c.x) - minX) / step));
  const j0 = Math.max(0, Math.ceil((Math.min(a.z, b.z, c.z) - minZ) / step));
  const j1 = Math.min(nz - 1, Math.floor((Math.max(a.z, b.z, c.z) - minZ) / step));
  if (i0 > i1 || j0 > j1) return;
  const inv = 1 / area;
  for (let j = j0; j <= j1; j++) {
    const pz = minZ + j * step;
    for (let i = i0; i <= i1; i++) {
      const px = minX + i * step;
      const w0 = ((b.x - px) * (c.z - pz) - (c.x - px) * (b.z - pz)) * inv;
      const w1 = ((c.x - px) * (a.z - pz) - (a.x - px) * (c.z - pz)) * inv;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      const y = w0 * a.y + w1 * b.y + w2 * c.y;
      const k = j * nx + i;
      if (y > data[k]) {
        data[k] = y;
        if (ids) ids[k] = id;
      }
    }
  }
}

/** Rasterise every mesh under `object` (world space, top-down) keeping the highest surface per cell. */
export function rasterizeObject(object, grid, ids, id) {
  object.updateWorldMatrix(true, true);
  object.traverse((o) => {
    if (!o.isMesh || o.userData.noSonar) return;
    const meshId = o.userData.sonarId ?? id;
    const pos = o.geometry.attributes.position;
    const index = o.geometry.index;
    const count = index ? index.count : pos.count;
    const matrices = [];
    if (o.isInstancedMesh) {
      for (let n = 0; n < o.count; n++) {
        o.getMatrixAt(n, _m);
        matrices.push(_m.clone().premultiply(o.matrixWorld));
      }
    } else matrices.push(o.matrixWorld);
    for (const m of matrices) {
      for (let k = 0; k + 2 < count; k += 3) {
        _a.fromBufferAttribute(pos, index ? index.getX(k) : k).applyMatrix4(m);
        _b.fromBufferAttribute(pos, index ? index.getX(k + 1) : k + 1).applyMatrix4(m);
        _c.fromBufferAttribute(pos, index ? index.getX(k + 2) : k + 2).applyMatrix4(m);
        rasterTriangle(_a, _b, _c, grid, ids, meshId);
      }
    }
  });
}

function boxBlur(src, nx, nz, radius) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const w = 2 * radius + 1;
  for (let j = 0; j < nz; j++) {
    let acc = 0;
    for (let i = -radius; i <= radius; i++) acc += src[j * nx + Math.min(nx - 1, Math.max(0, i))];
    for (let i = 0; i < nx; i++) {
      tmp[j * nx + i] = acc / w;
      acc += src[j * nx + Math.min(nx - 1, i + radius + 1)] - src[j * nx + Math.max(0, i - radius)];
    }
  }
  for (let i = 0; i < nx; i++) {
    let acc = 0;
    for (let j = -radius; j <= radius; j++) acc += tmp[Math.min(nz - 1, Math.max(0, j)) * nx + i];
    for (let j = 0; j < nz; j++) {
      out[j * nx + i] = acc / w;
      acc += tmp[Math.min(nz - 1, j + radius + 1) * nx + i] - tmp[Math.max(0, j - radius) * nx + i];
    }
  }
  return out;
}

/**
 * RGBA detail texture over the whole seabed: R = sediment tone, G = contact shadow / ambient occlusion
 * around objects, B = sand-ripple mask.
 */
export function bakeSeabedDetail(rasterizeAll, { heightAt, albedoAt, rippleAt }) {
  const step = 0.5;
  const nx = Math.round((SEABED.maxX - SEABED.minX) / step);
  const nz = Math.round((SEABED.maxZ - SEABED.minZ) / step);
  const grid = new Grid(SEABED.minX + step / 2, SEABED.minZ + step / 2, step, nx, nz, -Infinity);
  rasterizeAll(grid, null);

  const occupancy = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const top = grid.data[k];
      if (top === -Infinity) continue;
      const x = grid.minX + i * step;
      const z = grid.minZ + j * step;
      occupancy[k] = Math.min(Math.max((top - heightAt(x, z)) / 1.1, 0), 1.6);
    }
  }
  const ao = boxBlur(boxBlur(occupancy, nx, nz, 3), nx, nz, 3);

  const rgba = new Uint8Array(nx * nz * 4);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = grid.minX + i * step;
      const z = grid.minZ + j * step;
      rgba[k * 4] = Math.round(clamp01(albedoAt(x, z)) * 255);
      rgba[k * 4 + 1] = Math.round((1 - 0.62 * clamp01(ao[k] * 0.9)) * 255);
      rgba[k * 4 + 2] = Math.round(clamp01(rippleAt(x, z)) * 255);
      rgba[k * 4 + 3] = 255;
    }
  }
  return { data: rgba, width: nx, height: nz, rect: [SEABED.minX, SEABED.minZ, nx * step, nz * step] };
}

// ---------------------------------------------------------------------------------------------- sonar

/** Backscatter strength by rasterised material id: 1 metal, 2 rock, 3 netting. */
const REFLECTIVITY = [0, 0.98, 0.8, 0.4];
export const SONAR_STEP = 0.16;
export const WATERFALL_HALF = 160; // waterfall columns per side

/** Amber side-scan palette (sRGB), shared by the seabed paint and the live waterfall. */
export const SONAR_PALETTE = [
  [0, '#050302'],
  [0.22, '#3a1d06'],
  [0.5, '#b86a14'],
  [0.78, '#f2c46a'],
  [1, '#fff6dc'],
];
/** Cool "scanned" palette for the image draped on the 3D seabed (contrasts with the yellow AUV). */
export const DRAPE_PALETTE = [
  [0, '#02070c'],
  [0.28, '#07334a'],
  [0.56, '#0f89a6'],
  [0.8, '#63d9ef'],
  [1, '#effdff'],
];
const PALETTE_RGB = SONAR_PALETTE.map(([p, hex]) => [p, [1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16))]);

function paletteRGB(v, out) {
  for (let s = 1; s < PALETTE_RGB.length; s++) {
    const [p1, c1] = PALETTE_RGB[s];
    if (v <= p1 || s === PALETTE_RGB.length - 1) {
      const [p0, c0] = PALETTE_RGB[s - 1];
      const f = clamp01((v - p0) / (p1 - p0));
      out[0] = c0[0] + (c1[0] - c0[0]) * f;
      out[1] = c0[1] + (c1[1] - c0[1]) * f;
      out[2] = c0[2] + (c1[2] - c0[2]) * f;
      return out;
    }
  }
  return out;
}

export function sonarGeometry() {
  const half = Math.round(SURVEY.range / SONAR_STEP);
  const nx = half * 2 + 1;
  const nz = Math.round((SURVEY.scanOffZ - SURVEY.scanOnZ) / SONAR_STEP) + 1;
  const minX = -half * SONAR_STEP;
  return {
    half, nx, nz, minX, minZ: SURVEY.scanOnZ,
    // texel-centred rectangle for the seabed shader
    rect: [minX - SONAR_STEP / 2, SURVEY.scanOnZ - SONAR_STEP / 2, nx * SONAR_STEP, nz * SONAR_STEP],
    slantMax: Math.hypot(SURVEY.range, SURVEY.altitude + 1.5),
  };
}

const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Simulate the survey line. Returns the ground-range image (for draping on the seabed) and the
 * slant-range waterfall (what an operator sees live, with the dark water column down the middle).
 */
export async function simulateSideScan(rasterizeAll, { heightAt: terrainAt, albedoAt, rippleAt }, fishEchoes) {
  const g = sonarGeometry();
  const { half, nx, nz } = g;
  const objects = new Grid(g.minX, g.minZ, SONAR_STEP, nx, nz, -Infinity);
  const ids = new Uint8Array(nx * nz);
  rasterizeAll(objects, ids);
  await nextFrame();

  const surface = (j, out) => {
    const z = g.minZ + j * SONAR_STEP;
    for (let i = 0; i < nx; i++) {
      const x = g.minX + i * SONAR_STEP;
      const h = terrainAt(x, z) + RIPPLE.amp * rippleWave(x, z) * rippleAt(x, z);
      const o = objects.data[j * nx + i];
      out[i] = o > h ? o : h;
    }
    return out;
  };

  const rnd = mulberry32(99);
  const rayleigh = () => Math.sqrt(-2 * Math.log(1 - rnd() * 0.9999)) * 0.8;
  const ground = new Uint8Array(nx * nz);
  const altitude = new Float32Array(nz);
  let prev = surface(0, new Float32Array(nx));
  let cur = surface(0, new Float32Array(nx));
  let next = surface(Math.min(1, nz - 1), new Float32Array(nx));

  for (let j = 0; j < nz; j++) {
    const z = g.minZ + j * SONAR_STEP;
    const ty = transducerY(z);
    const alt = ty - terrainAt(0, z);
    altitude[j] = alt;
    const rowGain = 1 + (rnd() - 0.5) * 0.09; // ping-to-ping gain jitter
    ground[j * nx + half] = Math.round(0.02 * 255);

    for (const side of [1, -1]) {
      let minSlope = Infinity;
      for (let k = 1; k <= half; k++) {
        const i = half + side * k;
        const r = k * SONAR_STEP;
        const h = cur[i];
        const slope = (ty - h) / r; // tangent of the depression angle to this cell
        let v;
        if (slope > minSlope + 1e-5) {
          v = 0.03 * rayleigh(); // acoustic shadow: something nearer blocks the ray
        } else {
          minSlope = slope;
          const il = Math.max(0, i - 1);
          const ir = Math.min(nx - 1, i + 1);
          const gx = (cur[ir] - cur[il]) / ((ir - il) * SONAR_STEP);
          const gz = (next[i] - prev[i]) / (2 * SONAR_STEP);
          const dx = -side * r;
          const dy = ty - h;
          const cosI = Math.max(0, (-gx * dx + dy) / (Math.hypot(gx, 1, gz) * Math.hypot(dx, dy)));
          const cosFlat = alt / Math.hypot(r, alt);
          const id = ids[j * nx + i];
          const x = side * r;
          const refl = id ? REFLECTIVITY[id] : 0.34 + 0.2 * albedoAt(x, z);
          v = refl * Math.pow(cosI / cosFlat, 1.1) * (1 - 0.16 * (r / SURVEY.range) ** 2) * rayleigh();
        }
        if (r < 1.4) v *= r / 1.4;
        ground[j * nx + i] = Math.round(Math.pow(clamp01(v * rowGain), 0.85) * 255);
      }
    }

    [prev, cur, next] = [cur, next, prev];
    if (j + 2 < nz) surface(j + 2, next);
    else next.set(cur);
    if (j % 140 === 139) await nextFrame();
  }

  // Slant-range waterfall, newest ping at the top.
  const wfW = WATERFALL_HALF * 2;
  const pixels = new Uint8ClampedArray(wfW * nz * 4);
  const rgb = [0, 0, 0];
  for (let j = 0; j < nz; j++) {
    const alt = altitude[j];
    const row = nz - 1 - j;
    for (let c = 0; c < wfW; c++) {
      const port = c < WATERFALL_HALF;
      const s = ((port ? WATERFALL_HALF - 0.5 - c : c - WATERFALL_HALF + 0.5) / WATERFALL_HALF) * g.slantMax;
      let v;
      if (s < alt - 0.3) v = 0.01 + 0.02 * rnd(); // water column
      else if (s < alt + 0.35) v = 0.5 + 0.4 * rnd(); // first bottom return
      else {
        const k = Math.min(half, Math.round(Math.sqrt(s * s - alt * alt) / SONAR_STEP));
        v = ground[j * nx + half + (port ? k : -k)] / 255;
      }
      paletteRGB(v, rgb);
      const o = (row * wfW + c) * 4;
      pixels[o] = rgb[0];
      pixels[o + 1] = rgb[1];
      pixels[o + 2] = rgb[2];
      pixels[o + 3] = 255;
    }
  }
  // Fish show up as a cloud of echoes in the water column.
  for (const f of fishEchoes) {
    const j = Math.round((f.z - g.minZ) / SONAR_STEP);
    if (j < 0 || j >= nz) continue;
    const s = Math.hypot(f.x, transducerY(f.z) - f.y);
    const col = Math.round(f.x >= 0 ? WATERFALL_HALF - 0.5 - (s / g.slantMax) * WATERFALL_HALF : WATERFALL_HALF - 0.5 + (s / g.slantMax) * WATERFALL_HALF);
    const row = nz - 1 - j;
    paletteRGB(0.65 + 0.3 * rnd(), rgb);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 0; dx++) {
        const r = row + dy;
        const c = col + dx;
        if (r < 0 || r >= nz || c < 0 || c >= wfW) continue;
        const o = (r * wfW + c) * 4;
        pixels[o] = rgb[0];
        pixels[o + 1] = rgb[1];
        pixels[o + 2] = rgb[2];
      }
    }
  }

  // The draped copy is despeckled (as the pipeline's Clean step would) so shapes read at a distance.
  const soft = boxBlur(boxBlur(Float32Array.from(ground), nx, nz, 1), nx, nz, 1);
  const drape = new Uint8Array(nx * nz);
  for (let k = 0; k < drape.length; k++) drape[k] = Math.round(soft[k]);
  // Fill the nadir gap from its neighbours, as mosaicking software does.
  const gap = Math.ceil(1.6 / SONAR_STEP);
  for (let j = 0; j < nz; j++) {
    for (let k = -gap; k <= gap; k++) {
      const src = half + (k < 0 ? -gap - 1 : gap + 1);
      drape[j * nx + half + k] = drape[j * nx + src];
    }
  }

  return { ground, drape, width: nx, height: nz, rect: g.rect, waterfall: { pixels, width: wfW, height: nz }, altitude };
}

/** A target's box in waterfall pixels (columns: slant range, rows: newest at the top). */
export function waterfallBox(target, altitude) {
  const g = sonarGeometry();
  const h = (target.heading * Math.PI) / 180;
  const [len, wid] = target.dims;
  const across = Math.abs(len * Math.sin(h)) + Math.abs(wid * Math.cos(h));
  const along = Math.abs(len * Math.cos(h)) + Math.abs(wid * Math.sin(h));
  const j = Math.min(g.nz - 1, Math.max(0, Math.round((target.z - g.minZ) / SONAR_STEP)));
  const alt = altitude[j] - (target.kind === 'fish' ? 4.6 : 0);
  const near = Math.max(0, Math.abs(target.x) - across / 2);
  const far = Math.abs(target.x) + across / 2;
  const toCol = (ground) => (Math.hypot(ground, alt) / g.slantMax) * WATERFALL_HALF;
  const c0 = toCol(near);
  const c1 = toCol(far);
  const port = target.x >= 0;
  return {
    x0: port ? WATERFALL_HALF - c1 : WATERFALL_HALF + c0,
    x1: port ? WATERFALL_HALF - c0 : WATERFALL_HALF + c1,
    row: g.nz - 1 - j,
    halfRows: along / 2 / SONAR_STEP,
  };
}
