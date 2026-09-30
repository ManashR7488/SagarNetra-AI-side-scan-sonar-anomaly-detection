/**
 * Procedural models for the hero scene. Everything is built from primitives at runtime (no downloads).
 * Local convention: long axis along +x for seabed targets; the AUV points along +z with +y up.
 */
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createNoise2D, mulberry32, smoothstep } from './noise';

const rnd = mulberry32(8812);
const noise = createNoise2D(rnd);
const noise3 = (x, y, z) => (noise(x + 1.7 * z, y) + noise(y + 2.3 * x, z - 4.1) + noise(z + 0.7 * y, x + 9.2)) / 3;

/** Vertex colours that read as corroded, silted and encrusted surfaces. */
function weather(geometry, { base, rust, growth, silt, scale = 0.7, seed = 0 }) {
  const pos = geometry.attributes.position;
  const nrm = geometry.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const [cb, cr, cg, cs] = [base, rust, growth, silt].map((h) => new THREE.Color(h));
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) * scale + seed;
    const y = pos.getY(i) * scale;
    const z = pos.getZ(i) * scale - seed;
    const a = noise3(x, y, z) * 0.5 + 0.5;
    const b = noise3(x * 2.3 + 5, y * 2.3, z * 2.3) * 0.5 + 0.5;
    c.copy(cb).lerp(cr, smoothstep(0.35, 0.8, a));
    c.lerp(cg, smoothstep(0.55, 0.92, b) * 0.85);
    if (nrm) c.lerp(cs, smoothstep(0.3, 0.95, nrm.getY(i)) * 0.5);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

const weathered = (props) => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.25, ...props });

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------------------------- AUV

function hullDecal(radius, z0, z1, text, side) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 128;
  const g = canvas.getContext('2d');
  g.fillStyle = '#101418';
  g.font = '700 70px "Segoe UI", Arial, sans-serif';
  g.textBaseline = 'middle';
  g.fillText(text, 24, 66);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;

  // A strip wrapped around the upper side of the hull (above the sonar arrays), text along the length.
  const span = 0.62;
  const centre = 0.38;
  const cols = 24;
  const rows = 6;
  const pos = [];
  const uv = [];
  const idx = [];
  for (let r = 0; r <= rows; r++) {
    const phi = centre - span / 2 + (r / rows) * span;
    for (let k = 0; k <= cols; k++) {
      const z = z0 + (k / cols) * (z1 - z0);
      pos.push(side * radius * Math.cos(phi), radius * Math.sin(phi), z);
      uv.push(side > 0 ? 1 - k / cols : k / cols, r / rows);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const a = r * (cols + 1) + k;
      const b = a + cols + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ map, transparent: true, roughness: 0.4, side: THREE.DoubleSide, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 2;
  return mesh;
}

export function createAUV() {
  const group = new THREE.Group();
  const yellow = new THREE.MeshStandardMaterial({ color: '#f4b000', roughness: 0.3, metalness: 0.05 });
  const dark = new THREE.MeshStandardMaterial({ color: '#23272d', roughness: 0.55, metalness: 0.35 });
  const black = new THREE.MeshStandardMaterial({ color: '#0c0e11', roughness: 0.35, metalness: 0.2 });
  const white = new THREE.MeshStandardMaterial({ color: '#eef2f4', roughness: 0.3 });

  const L = 5.4;
  const R = 0.42;
  const tailLen = 1.35;
  const noseLen = 0.8;
  const zTail = -L / 2;
  const zBody0 = zTail + tailLen;
  const zBody1 = L / 2 - noseLen;
  const lathe = (pts, mat, segments = 48) => {
    const geo = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), segments);
    geo.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(geo, mat);
    group.add(mesh);
    return mesh;
  };

  const tail = [[0, zTail], [0.09, zTail]];
  for (let i = 1; i <= 14; i++) {
    const s = i / 14;
    tail.push([0.09 + (R - 0.09) * (1 - (1 - s) ** 2.2), zTail + s * tailLen]);
  }
  lathe(tail, dark);
  lathe([[R, zBody0], [R, zBody1]], yellow);
  const nose = (a0, a1, mat) => {
    const pts = [];
    for (let i = 0; i <= 12; i++) {
      const th = (a0 + ((a1 - a0) * i) / 12) * (Math.PI / 2);
      pts.push([R * Math.cos(th), zBody1 + noseLen * Math.sin(th)]);
    }
    if (a1 === 1) pts[pts.length - 1][0] = 0;
    lathe(pts, mat);
  };
  nose(0, 0.58, yellow);
  nose(0.58, 1, black);
  lathe([[R + 0.004, 0.95], [R + 0.004, 1.07]], white);
  for (const z of [-0.55, 0.42, 1.5]) lathe([[R + 0.003, z], [R + 0.003, z + 0.018]], dark);

  // Side-scan transducer arrays, one per side, angled down and out.
  for (const side of [1, -1]) {
    const array = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.1, 1.55), black);
    array.position.set(side * (R - 0.006), -0.15, 0.35);
    array.rotation.z = side * 0.42;
    group.add(array);
    group.add(hullDecal(R + 0.003, -0.35, 0.85, 'SAGARNETRA  AUV-01', side));
  }

  // Cruciform control fins.
  const finShape = new THREE.Shape();
  finShape.moveTo(0, 0);
  finShape.lineTo(0, 0.44);
  finShape.lineTo(0.32, 0.3);
  finShape.lineTo(0.32, 0.1);
  finShape.closePath();
  const finGeo = new THREE.ExtrudeGeometry(finShape, { depth: 0.022, bevelEnabled: false });
  finGeo.translate(0.17, 0, -0.011);
  finGeo.rotateX(Math.PI / 2);
  for (let k = 0; k < 4; k++) {
    const fin = new THREE.Mesh(finGeo, dark);
    fin.position.z = zTail + 0.12;
    fin.rotation.z = (k * Math.PI) / 2;
    group.add(fin);
  }

  // Ducted propeller.
  const duct = new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.034, 12, 40), dark);
  duct.position.z = zTail - 0.1;
  group.add(duct);
  const prop = new THREE.Group();
  prop.position.z = zTail - 0.1;
  const hub = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.2, 16).rotateX(-Math.PI / 2), black);
  prop.add(hub);
  for (let k = 0; k < 5; k++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.17, 0.07), black);
    blade.position.y = 0.11;
    blade.rotation.y = 0.55;
    const arm = new THREE.Group();
    arm.rotation.z = (k * 2 * Math.PI) / 5;
    arm.add(blade);
    prop.add(arm);
  }
  group.add(prop);
  for (let k = 0; k < 3; k++) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.16, 0.05), dark);
    strut.position.set(0, 0.15, 0);
    const arm = new THREE.Group();
    arm.position.z = zTail - 0.1;
    arm.rotation.z = (k * 2 * Math.PI) / 3 + 0.5;
    arm.add(strut);
    group.add(arm);
  }

  // Mast with GNSS / Iridium antenna and recovery strobe.
  const mastShape = new THREE.Shape();
  mastShape.moveTo(0, 0);
  mastShape.lineTo(0.42, 0);
  mastShape.lineTo(0.3, 0.3);
  mastShape.lineTo(0.12, 0.3);
  mastShape.closePath();
  const mastGeo = new THREE.ExtrudeGeometry(mastShape, { depth: 0.045, bevelEnabled: false });
  mastGeo.translate(-0.21, 0, -0.0225);
  mastGeo.rotateY(-Math.PI / 2);
  const mast = new THREE.Mesh(mastGeo, dark);
  mast.position.set(0, R - 0.03, -1.05);
  group.add(mast);
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.028, 0.28, 12), black);
  antenna.position.set(0, R + 0.4, -1.08);
  group.add(antenna);
  const strobe = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
  strobe.position.set(0, R + 0.57, -1.08);
  group.add(strobe);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: '#dff6ff', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  glow.scale.setScalar(1.6);
  glow.position.copy(strobe.position);
  group.add(glow);

  // Doppler velocity log and the downward camera light.
  const dvl = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.03, 24), black);
  dvl.position.set(0, -R + 0.01, 1.55);
  group.add(dvl);
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 16), new THREE.MeshBasicMaterial({ color: '#fff6e0' }));
  lamp.position.set(0, -R + 0.005, 1.15);
  group.add(lamp);
  const spot = new THREE.SpotLight('#fff1d6', 55, 26, 0.72, 0.75, 1.4);
  spot.position.set(0, -R, 1.2);
  spot.target.position.set(0, -10, 4.5);
  group.add(spot, spot.target);

  return { group, prop, strobe, glow, radius: R, length: L, transducer: new THREE.Vector3(R - 0.01, -0.16, 0.35) };
}

/** Two thin fans (port / starboard) hanging from the transducers down to the seabed. */
export function createFans(material, { altitude, range, near = 1.8 }) {
  const depth = altitude + 1.4;
  const fans = [];
  for (const side of [1, -1]) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, side * near, -depth, 0, side * range, -depth, 0], 3));
    const mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    fans.push(mesh);
  }
  material.uniforms.uSlant.value = Math.hypot(range, depth);
  material.uniforms.uAngles.value.set(Math.atan2(depth, near), Math.atan2(depth, range));
  return fans;
}

// ---------------------------------------------------------------------------------------------- wreck

const halfBeam = (s, B) => (B / 2) * Math.max(0.05, s < 0.5 ? 0.86 + 0.14 * Math.sin((s / 0.5) * (Math.PI / 2)) : Math.cos(((s - 0.5) / 0.5) * (Math.PI / 2)) ** 0.75);
const hullDepth = (s) => 2.3 + 0.7 * Math.sin(Math.PI * Math.min(1, s * 1.15));
const sheer = (s) => 0.9 * s ** 3 + 0.25 * (1 - s) ** 3;

function hullGeometry(L, B) {
  const K = 46;
  const M = 18;
  const pos = [];
  const idx = [];
  for (let k = 0; k <= K; k++) {
    const s = k / K;
    const u = (s - 0.5) * L;
    const b = halfBeam(s, B);
    const D = hullDepth(s);
    const sh = sheer(s);
    for (let m = 0; m <= M; m++) {
      const th = -Math.PI / 2 + (m / M) * Math.PI;
      pos.push(u, sh - D * Math.cos(th) ** 0.8, b * Math.sin(th));
    }
  }
  for (let k = 0; k < K; k++) {
    for (let m = 0; m < M; m++) {
      const a = k * (M + 1) + m;
      const b = a + M + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const deck = pos.length / 3;
  for (let k = 0; k <= K; k++) {
    const s = k / K;
    const b = halfBeam(s, B) * 0.95;
    const y = sheer(s) - 0.28;
    pos.push((s - 0.5) * L, y, -b, (s - 0.5) * L, y, b);
  }
  for (let k = 0; k < K; k++) {
    const a = deck + k * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const cap = pos.length / 3;
  pos.push(-L / 2, sheer(0) - hullDepth(0) * 0.45, 0);
  for (let m = 0; m < M; m++) idx.push(cap, m + 1, m);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

const RUST = { base: '#3f3226', rust: '#7b4a27', growth: '#4f5c46', silt: '#8a8470' };

export function createWreck() {
  const group = new THREE.Group();
  const L = 21;
  const B = 6.2;
  const mat = weathered({ side: THREE.DoubleSide, roughness: 0.9 });
  group.add(new THREE.Mesh(weather(hullGeometry(L, B), { ...RUST, scale: 0.35 }), mat));

  const add = (geo, x, y, z, rx = 0, ry = 0, rz = 0, material = mat) => {
    const mesh = new THREE.Mesh(weather(geo, { ...RUST, seed: x }), material);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    group.add(mesh);
    return mesh;
  };
  const deckY = (s) => sheer(s) - 0.28;
  // Wheelhouse (slumped), window band, winch, A-frame, fallen mast and loose gear.
  add(new THREE.BoxGeometry(3.4, 2.3, 2.9), -5.3, deckY(0.25) + 1.1, 0, 0, 0, 0.05);
  const windows = new THREE.Mesh(new THREE.BoxGeometry(3.45, 0.42, 2.95), new THREE.MeshStandardMaterial({ color: '#07090b', roughness: 0.3 }));
  windows.position.set(-5.28, deckY(0.25) + 1.75, 0);
  windows.rotation.z = 0.05;
  group.add(windows);
  add(new THREE.BoxGeometry(2.2, 0.9, 2.2), -5.6, deckY(0.25) + 2.65, 0.1, 0, 0.1, 0.05);
  add(new THREE.CylinderGeometry(0.5, 0.5, 1.9, 16).rotateX(Math.PI / 2), -1.8, deckY(0.45) + 0.55, 0);
  for (const side of [1, -1]) add(new THREE.CylinderGeometry(0.12, 0.14, 4, 8), -9.4, deckY(0.05) + 1.7, side * 1.25, side * 0.32, 0, 0.18);
  add(new THREE.CylinderGeometry(0.12, 0.12, 2.8, 8).rotateX(Math.PI / 2), -9.05, deckY(0.05) + 3.5, 0);
  add(new THREE.CylinderGeometry(0.14, 0.09, 8.5, 10), 2.4, deckY(0.6) + 0.3, 2.6, 0.95, 0.35, 1.25);
  add(new THREE.BoxGeometry(1.1, 0.8, 0.9), 4.6, deckY(0.72) + 0.4, -1.1, 0, 0.5, 0.1);
  add(new THREE.BoxGeometry(0.8, 0.6, 1.4), 1.1, deckY(0.55) + 0.3, 1.4, 0.1, -0.3, 0);
  add(new THREE.CylinderGeometry(0.3, 0.3, 0.9, 12), 6.8, deckY(0.8) + 0.45, 0.6, 0.2, 0, 0.1);
  group.userData.sonarId = 1;
  return group;
}

// ---------------------------------------------------------------------------------------------- aircraft

const ALUMINIUM = { base: '#b7bfc3', rust: '#8f928a', growth: '#5c6a51', silt: '#8d8878' };

export function createAircraft() {
  const group = new THREE.Group();
  const mat = weathered({ metalness: 0.45, roughness: 0.6, side: THREE.DoubleSide });
  const L = 8.6;
  const pts = [];
  for (let i = 0; i <= 28; i++) {
    const s = i / 28;
    const r = s < 0.62 ? 0.14 + 0.54 * smoothstep(0, 0.62, s) ** 0.85 : 0.68 * Math.sqrt(1 - ((s - 0.62) / 0.38) ** 2 * 0.92);
    pts.push(new THREE.Vector2(i === 0 ? 0 : r, (s - 0.5) * L));
  }
  pts.push(new THREE.Vector2(0, L / 2));
  const fuselage = new THREE.LatheGeometry(pts, 32).rotateZ(-Math.PI / 2);
  group.add(new THREE.Mesh(weather(fuselage, { ...ALUMINIUM, scale: 0.5 }), mat));

  const add = (geo, x, y, z, rx = 0, ry = 0, rz = 0, material = mat) => {
    const mesh = new THREE.Mesh(weather(geo, { ...ALUMINIUM, seed: z }), material);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    group.add(mesh);
    return mesh;
  };
  add(new THREE.BoxGeometry(1.5, 0.13, 5.4), 0.9, 0.63, 3.05, 0.1, 0, 0);
  add(new THREE.BoxGeometry(1.5, 0.13, 0.9), 0.9, 0.63, -0.95);
  add(new THREE.BoxGeometry(1.5, 0.13, 4.6), -0.6, -0.28, -4.4, 0.06, 0.55, 0.14);
  add(new THREE.BoxGeometry(0.8, 0.07, 3), -3.95, 0.05, 0, 0, 0, 0.04);
  const fin = new THREE.Shape();
  fin.moveTo(0, 0);
  fin.lineTo(1.1, 0);
  fin.lineTo(0.55, 1.15);
  fin.lineTo(0.15, 1.15);
  fin.closePath();
  add(new THREE.ExtrudeGeometry(fin, { depth: 0.07, bevelEnabled: false }), -4.35, 0.12, -0.035);
  const glass = new THREE.MeshStandardMaterial({ color: '#0a0d10', roughness: 0.2, metalness: 0.4 });
  const windows = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.34, 1.37), glass);
  windows.position.set(1.4, 0.36, 0);
  group.add(windows);
  add(new THREE.ConeGeometry(0.2, 0.4, 16).rotateZ(-Math.PI / 2), 4.45, 0, 0);
  add(new THREE.BoxGeometry(0.06, 1.7, 0.14), 4.5, 0.05, 0, 0.35, 0, 0.25);
  group.userData.sonarId = 1;
  return group;
}

// ---------------------------------------------------------------------------------------------- mine / pipe

const OLIVE = { base: '#3a4337', rust: '#6d4a2c', growth: '#56654a', silt: '#7d7a68' };
const CONCRETE = { base: '#77796f', rust: '#5f5d52', growth: '#56634a', silt: '#8e8a78' };

export function createMine() {
  const group = new THREE.Group();
  const mat = weathered({ metalness: 0.4, roughness: 0.7 });
  const add = (geo, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(weather(geo, { ...OLIVE, scale: 1.4, seed: x }), mat);
    mesh.position.set(x, y, z);
    group.add(mesh);
  };
  add(new THREE.CapsuleGeometry(0.52, 1.6, 8, 24).rotateZ(Math.PI / 2));
  for (const x of [-0.55, 0.55]) add(new THREE.TorusGeometry(0.525, 0.03, 8, 32).rotateY(Math.PI / 2), x);
  for (const x of [-0.35, 0.35]) add(new THREE.TorusGeometry(0.1, 0.028, 8, 16), x, 0.54);
  add(new THREE.CylinderGeometry(0.1, 0.13, 0.2, 14).rotateZ(Math.PI / 2), 1.37);
  group.userData.sonarId = 1;
  return group;
}

export function createPipe() {
  const group = new THREE.Group();
  const outer = weathered({ side: THREE.DoubleSide, roughness: 0.95, metalness: 0.1 });
  const inner = new THREE.MeshStandardMaterial({ color: '#0b0d0c', roughness: 1, side: THREE.BackSide });
  const segment = (length, x, y, z, ry, rz) => {
    const seg = new THREE.Group();
    seg.add(new THREE.Mesh(weather(new THREE.CylinderGeometry(0.45, 0.45, length, 30, 1, true).rotateZ(Math.PI / 2), { ...CONCRETE, scale: 0.9, seed: x }), outer));
    seg.add(new THREE.Mesh(new THREE.CylinderGeometry(0.39, 0.39, length - 0.04, 20, 1, true).rotateZ(Math.PI / 2), inner));
    for (const end of [-1, 1]) {
      const rim = new THREE.Mesh(weather(new THREE.RingGeometry(0.39, 0.45, 30).rotateY((end * Math.PI) / 2), { ...CONCRETE, seed: end }), outer);
      rim.position.x = (end * length) / 2;
      seg.add(rim);
    }
    const anode = new THREE.Mesh(weather(new THREE.TorusGeometry(0.46, 0.05, 8, 30).rotateY(Math.PI / 2), { ...OLIVE }), outer);
    anode.position.x = length * 0.18;
    seg.add(anode);
    seg.position.set(x, y, z);
    seg.rotation.set(0, ry, rz);
    group.add(seg);
  };
  segment(5, -1.55, 0, 0, 0, 0);
  segment(3.1, 2.75, -0.08, 0.32, 0.24, 0.05);
  const flange = new THREE.Mesh(weather(new THREE.TorusGeometry(0.5, 0.07, 8, 30).rotateY(Math.PI / 2), { ...OLIVE }), outer);
  flange.position.x = -4.05;
  group.add(flange);
  group.userData.sonarId = 1;
  return group;
}

// ---------------------------------------------------------------------------------------------- rocks

function rockGeometry(seed) {
  let geo = new THREE.IcosahedronGeometry(1, 3);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = mergeVertices(geo);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const d = 1 + 0.22 * noise3(v.x * 1.3 + seed, v.y * 1.3, v.z * 1.3) + 0.09 * noise3(v.x * 3.1, v.y * 3.1 + seed, v.z * 3.1);
    v.multiplyScalar(d);
    if (v.y < -0.2) v.y = -0.2 + (v.y + 0.2) * 0.3;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return weather(geo, { base: '#57554d', rust: '#6c6557', growth: '#4e5a45', silt: '#8e8976', scale: 1.1, seed });
}

const ROCK_MATERIAL = () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });

/** Instanced rocks; each entry of `rocks` is { x, z, r, flat, rot, tilt, variant }. */
export function createRocks(rocks, terrainAt) {
  const group = new THREE.Group();
  const material = ROCK_MATERIAL();
  const dummy = new THREE.Object3D();
  for (let variant = 0; variant < 3; variant++) {
    const list = rocks.filter((r) => r.variant === variant);
    const mesh = new THREE.InstancedMesh(rockGeometry(variant * 17.3), material, list.length);
    list.forEach((r, i) => {
      dummy.position.set(r.x, terrainAt(r.x, r.z) - 0.25 * r.r * r.flat, r.z);
      dummy.rotation.set(r.tilt, r.rot, r.tilt * 0.5);
      dummy.scale.set(r.r * 1.15, r.r * r.flat, r.r);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.frustumCulled = false;
    mesh.userData.sonarId = 2;
    group.add(mesh);
  }
  return group;
}

// ---------------------------------------------------------------------------------------------- ghost net

function netTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.strokeStyle = '#ffffff';
  g.lineWidth = 5;
  for (let k = -128; k <= 256; k += 32) {
    g.beginPath();
    g.moveTo(k, 0);
    g.lineTo(k + 128, 128);
    g.moveTo(k, 128);
    g.lineTo(k + 128, 0);
    g.stroke();
  }
  g.fillStyle = '#ffffff';
  for (let x = 0; x <= 128; x += 32) for (let y = 0; y <= 128; y += 32) {
    g.beginPath();
    g.arc(x + 16, y, 4.5, 0, Math.PI * 2);
    g.arc(x, y + 16, 4.5, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** A lost trawl net snagged on a boulder, floats still attached. `groundAt(lx, lz)` is local seabed height. */
export function createGhostNet(groundAt) {
  const group = new THREE.Group();
  const rx = 2.1;
  const ry = 1.55;
  const rz = 1.75;
  const rock = new THREE.Mesh(rockGeometry(3.3), ROCK_MATERIAL());
  rock.scale.set(rx, ry, rz);
  rock.position.y = groundAt(0, 0) - 0.15;
  rock.userData.sonarId = 2;
  group.add(rock);

  const geo = new THREE.PlaneGeometry(7.8, 5.6, 64, 46).rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const dn = Math.sqrt((x / rx) ** 2 + (z / rz) ** 2);
    const onRock = dn < 1 ? ry * Math.sqrt(1 - dn * dn) + 0.2 : 0;
    const tent = ry * 0.95 * (1 - smoothstep(0.55, 1.85, dn));
    const folds = 0.07 * noise(x * 1.3, z * 1.3) + 0.04 * noise(x * 3.7 + 9, z * 3.1);
    pos.setY(i, groundAt(x, z) + Math.max(onRock, tent, 0.05) + folds);
  }
  geo.computeVertexNormals();
  const map = netTexture();
  map.repeat.set(7.8 / 0.55, 5.6 / 0.55);
  const net = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: '#8b9476', alphaMap: map, transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 1,
  }));
  net.userData.sonarId = 3;
  net.renderOrder = 1;
  group.add(net);

  const floatMat = new THREE.MeshStandardMaterial({ color: '#d4652a', roughness: 0.55 });
  for (let k = 0; k < 6; k++) {
    const x = -3.4 + k * 1.25;
    const z = 2.55 + 0.25 * Math.sin(k * 1.7);
    const f = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 10), floatMat);
    f.position.set(x, groundAt(x, z) + 0.28 + 0.2 * Math.sin(k), z);
    group.add(f);
  }
  const ropePts = [];
  for (let k = 0; k <= 8; k++) {
    const x = 3.8 + k * 0.7;
    const z = -2.2 - 0.9 * Math.sin(k * 0.6);
    ropePts.push(new THREE.Vector3(x, groundAt(x, z) + 0.06, z));
  }
  const rope = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ropePts), 40, 0.035, 6), new THREE.MeshStandardMaterial({ color: '#3b3a31', roughness: 1 }));
  group.add(rope);
  return group;
}

// ---------------------------------------------------------------------------------------------- fish

export function createFishSchool(count = 70) {
  const pts = [];
  for (let i = 0; i <= 12; i++) {
    const s = i / 12;
    pts.push(new THREE.Vector2(0.075 * Math.sin(Math.PI * s ** 1.3), (s - 0.55) * 0.5));
  }
  const body = new THREE.LatheGeometry(pts, 10).rotateX(Math.PI / 2).toNonIndexed();
  body.scale(0.42, 1, 1);
  body.deleteAttribute('uv');
  body.deleteAttribute('normal');
  const tail = new THREE.BufferGeometry();
  tail.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.24, 0, 0.1, -0.36, 0, -0.1, -0.36], 3));
  const geo = mergeGeometries([body, tail]);
  geo.computeVertexNormals();

  const phases = new Float32Array(count);
  for (let i = 0; i < count; i++) phases[i] = rnd() * Math.PI * 2;
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));

  const uniforms = { uTime: { value: 0 } };
  const material = new THREE.MeshStandardMaterial({ color: '#b9ccd8', metalness: 0.65, roughness: 0.3, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nattribute float aPhase;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.x += sin(uTime * 11.0 + aPhase + position.z * 9.0) * 0.05 * (1.0 - smoothstep(-0.35, 0.1, position.z));');
  };
  const mesh = new THREE.InstancedMesh(geo, material, count);
  mesh.frustumCulled = false;

  const fish = Array.from({ length: count }, (_, i) => ({
    radius: 0.9 + rnd() * 1.9,
    height: (rnd() - 0.5) * 1.8,
    angle: rnd() * Math.PI * 2,
    speed: 0.45 + rnd() * 0.25,
    scale: 0.8 + rnd() * 0.5,
    wobble: rnd() * Math.PI * 2,
    i,
  }));
  return { mesh, fish, uniforms };
}
