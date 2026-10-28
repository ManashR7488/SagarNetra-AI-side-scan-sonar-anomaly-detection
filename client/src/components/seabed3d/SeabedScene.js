/**
 * Interactive 3D seabed (plain three.js, loaded lazily by SeabedViewer).
 *
 * One or more survey strips (the selected scan plus, optionally, neighbouring lines). Two layouts:
 *   straightened  one strip, x = ground range u, z = along-track s - length / 2 (works without lat/lon)
 *   true geometry every strip laid along its real track in a local east / north frame: x = east, z = -north
 * y = (elevation - ref) * exaggeration everywhere. A "field" answers elevation / lat-lon at any world (x, z).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createAUV } from '../hero/ocean/models';
import {
  altitudeAt, buildWorldGrid, hasLatLon, heightAt, localToLatLon, makeFrame, niceInterval, niceLength, straightMapper,
  stripMapper,
} from './seabedData';

const MODES = { sonar: 0, depth: 1, shade: 2 };
const SONAR_RAMP = ['#050302', '#3a1d06', '#b86a14', '#f2c46a', '#fff6dc'];
const DEPTH_RAMP = ['#0b1d51', '#1d4f91', '#1f8fae', '#5cc8a5', '#e8e0a0'];   // deep -> shallow
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

const vertexShader = /* glsl */ `
  attribute float aElev;
  varying vec2 vUv;
  varying float vElev;
  varying vec3 vNormalW;
  void main() {
    vUv = uv;
    vElev = aElev;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uTex;
  uniform int uMode;
  uniform float uMin;
  uniform float uMax;
  uniform float uContour;
  uniform float uContours;
  uniform float uCoverage;
  uniform float uDiscard;
  uniform float uDim;
  uniform vec3 uLight;
  uniform vec3 uSonar[5];
  uniform vec3 uDepth[5];
  varying vec2 vUv;
  varying float vElev;
  varying vec3 vNormalW;

  vec3 ramp(vec3 c[5], float t) {
    t = clamp(t, 0.0, 1.0) * 4.0;
    int i = int(min(floor(t), 3.0));
    return mix(c[i], c[i + 1], t - float(i));
  }

  void main() {
    float echo = texture2D(uTex, vUv).r;
    float covered = smoothstep(0.012, 0.05, echo);
    // With several lines, a strip's gaps (dropouts, outside its swath) show the neighbour underneath.
    if (uDiscard > 0.5 && uCoverage < 0.5 && covered < 0.5) discard;
    vec3 n = normalize(vNormalW);
    float diff = max(dot(n, normalize(uLight)), 0.0);
    vec3 col;
    if (uMode == 0) {
      col = ramp(uSonar, pow(echo, 0.9)) * (0.6 + 0.55 * diff);
    } else if (uMode == 1) {
      float t = (vElev - uMin) / max(uMax - uMin, 1e-3);
      col = ramp(uDepth, t) * (0.42 + 0.75 * diff) * (0.88 + 0.24 * echo);
    } else {
      col = vec3(0.80, 0.76, 0.68) * (0.22 + 0.95 * diff);
    }
    col = mix(vec3(0.05, 0.07, 0.10) * (0.6 + 0.6 * diff), col, max(covered, uMode == 0 ? 0.0 : 0.35));
    if (uContours > 0.5) {
      float f = vElev / uContour;
      float w = fwidth(f);
      float line = 1.0 - smoothstep(0.0, w * 1.3, abs(fract(f - 0.5) - 0.5));
      col = mix(col, vec3(0.95, 0.98, 1.0), line * 0.55);
    }
    if (uCoverage > 0.5) col = mix(col, vec3(0.92, 0.18, 0.28), (1.0 - covered) * 0.85);
    gl_FragColor = vec4(col * uDim, 1.0);
  }
`;

const colorArray = (hexes) => hexes.map((h) => new THREE.Color(h).convertLinearToSRGB());

export default class SeabedScene {
  constructor({ host, labels, overlay, onSelect, onPointer, onMeasure }) {
    this.host = host;
    this.labelsEl = labels;
    this.overlay = overlay ?? {};
    this.onSelect = onSelect;
    this.onPointer = onPointer;
    this.onMeasure = onMeasure;
    this.disposed = false;
    this.exaggeration = 3;
    this.tool = 'orbit';
    this.selected = null;
    this.visibleClasses = null;
    this.includeSuppressed = false;
    this.showTargets = true;
    this.followT = null;
    this.measurePts = [];
    this.anim = null;
    this.dirty = true;
    this.disposables = [];
  }

  /**
   * strips: [{ model (loadSeabed result), textureUrl, scanId, name, primary, targets }]; primary first.
   * geo: lay strips on their real tracks (needs lat/lon); otherwise only the primary strip, straightened.
   */
  async build(strips, { geo = false } = {}) {
    const primary = strips[0];
    this.geo = geo && hasLatLon(primary.model);
    this.strips = (this.geo ? strips.filter((s) => hasLatLon(s.model)) : [primary]).map((s) => ({ ...s }));
    this.primaryModel = primary.model;
    this.measured = primary.model.kind === 'measured';
    this.ref = (primary.model.elevation.minM + primary.model.elevation.maxM) / 2;

    if (this.geo) {
      this.frame = makeFrame(primary.model.track.lat[0], primary.model.track.lon[0]);
      for (const st of this.strips) st.map = stripMapper(st.model, this.frame);
    } else {
      for (const st of this.strips) st.map = straightMapper(st.model);
    }

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.domElement.className = 'block w-full h-full outline-none';
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0a1626');

    const loader = new THREE.TextureLoader().setCrossOrigin('anonymous');
    const textures = await Promise.all(this.strips.map((st) => loader.loadAsync(st.textureUrl)));
    if (this.disposed) { textures.forEach((t) => t.dispose()); renderer.dispose(); return; }
    textures.forEach((t, i) => {
      t.colorSpace = THREE.NoColorSpace;
      t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      t.minFilter = THREE.LinearMipmapLinearFilter;
      this.strips[i].texture = t;
      this.disposables.push(t);
    });

    this.host.appendChild(renderer.domElement);
    this.buildTerrain();
    this.buildField();
    const { minX, maxX, minZ, maxZ } = this.field.bounds;
    this.center = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    this.radius = Math.max(10, 0.5 * Math.hypot(maxX - minX, maxZ - minZ));
    this.scene.fog = new THREE.Fog('#0a1626', this.radius * 2.4, this.radius * 7);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, this.radius * 20);

    this.buildTrack();
    this.buildTargets();
    this.buildMeasure();
    this.scene.add(new THREE.HemisphereLight('#bcd7ff', '#2b2216', 1.6));
    const sun = new THREE.DirectionalLight('#ffffff', 2.2);
    sun.position.set(-0.6, 1, 0.45);
    this.scene.add(sun);

    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 2;
    this.controls.maxDistance = this.radius * 8;
    this.controls.addEventListener('change', () => { this.dirty = true; });

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.bindEvents();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.resize();
    this.view('oblique', false);
    await renderer.compileAsync(this.scene, this.camera);
    if (this.disposed) return;
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  // ---------------------------------------------------------------- terrain
  buildTerrain() {
    let lo = Infinity;
    let hi = -Infinity;
    for (const st of this.strips) {
      lo = Math.min(lo, st.model.elevation.minM);
      hi = Math.max(hi, st.model.elevation.maxM);
    }
    this.elevRange = [lo, hi];
    // Colour range from the seabed itself (2nd-99th percentile), so a tall wreck does not flatten the depth colours.
    const sample = [];
    for (const st of this.strips) {
      const h = st.model.heights;
      for (let k = 0; k < h.length; k += Math.max(1, Math.floor(h.length / 20000))) sample.push(h[k]);
    }
    sample.sort((a, b) => a - b);
    const q = (p) => sample[Math.min(sample.length - 1, Math.max(0, Math.round(p * (sample.length - 1))))];
    this.colorRange = [q(0.02), Math.max(q(0.99), q(0.02) + 0.2)];
    this.common = {
      uMode: { value: MODES.sonar },
      uMin: { value: this.colorRange[0] },
      uMax: { value: this.colorRange[1] },
      uContour: { value: niceInterval(this.colorRange[1] - this.colorRange[0], 8) },
      uContours: { value: 0 },
      uCoverage: { value: 0 },
      uDiscard: { value: this.strips.length > 1 ? 1 : 0 },
      uLight: { value: new THREE.Vector3(-0.6, 1, 0.45) },
      uSonar: { value: colorArray(SONAR_RAMP) },
      uDepth: { value: colorArray(DEPTH_RAMP) },
    };
    this.strips.forEach((st, order) => {
      const { nx, nz, cellXM, cellZM, widthM } = st.model.grid;
      // neighbouring lines at half resolution: plenty for context, a quarter of the vertices
      const step = !st.primary && nx * nz > 120_000 ? 2 : 1;
      const cols = Math.floor((nx - 1) / step) + 1;
      const rows = Math.floor((nz - 1) / step) + 1;
      const n = cols * rows;
      const pos = new Float32Array(n * 3);
      const uv = new Float32Array(n * 2);
      const heights = new Float32Array(n);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const gi = i * step;
          const gj = j * step;
          const k = j * cols + i;
          const p = st.map(gj * cellZM, -widthM / 2 + gi * cellXM);
          pos[k * 3] = p.x;
          pos[k * 3 + 2] = p.z;
          uv[k * 2] = gi / (nx - 1);
          uv[k * 2 + 1] = 1 - gj / (nz - 1);
          heights[k] = st.model.heights[gj * nx + gi];
        }
      }
      const index = new Uint32Array((cols - 1) * (rows - 1) * 6);
      let q = 0;
      for (let j = 0; j < rows - 1; j++) {
        for (let i = 0; i < cols - 1; i++) {
          const a = j * cols + i;
          index.set([a, a + cols, a + 1, a + 1, a + cols, a + cols + 1], q);
          q += 6;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setAttribute('aElev', new THREE.BufferAttribute(heights, 1));
      geo.setIndex(new THREE.BufferAttribute(index, 1));
      const material = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: { ...this.common, uTex: { value: st.texture }, uDim: { value: st.primary ? 1 : 0.8 } },
        // the selected line wins where lines overlap
        polygonOffset: true,
        polygonOffsetFactor: st.primary ? -2 : order,
        polygonOffsetUnits: st.primary ? -4 : order * 2,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, material);
      this.scene.add(mesh);
      this.disposables.push(geo, material);
      Object.assign(st, { mesh, positions: pos, heights, cellM: cellXM * step });
    });
    this.applyHeights();
  }

  y(h) {
    return (h - this.ref) * this.exaggeration;
  }

  applyHeights() {
    for (const st of this.strips) {
      const geo = st.mesh.geometry;
      const pos = geo.attributes.position.array;
      for (let k = 0; k < st.heights.length; k++) pos[k * 3 + 1] = this.y(st.heights[k]);
      geo.attributes.position.needsUpdate = true;
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
    }
    this.dirty = true;
  }

  /** Elevation / position lookups at any world (x, z), whatever the layout. */
  buildField() {
    if (this.geo) {
      const grid = buildWorldGrid(this.strips);
      this.field = {
        bounds: grid.bounds,
        height: grid.at,
        latLon: (x, z) => this.frame.toLatLon(x, z),
      };
    } else {
      const m = this.primaryModel;
      const { widthM, lengthM } = m.grid;
      this.field = {
        bounds: { minX: -widthM / 2, maxX: widthM / 2, minZ: -lengthM / 2, maxZ: lengthM / 2 },
        height: (x, z) => (Math.abs(x) <= widthM / 2 && Math.abs(z) <= lengthM / 2 ? heightAt(m, z + lengthM / 2, x) : NaN),
        latLon: (x, z) => (hasLatLon(m) ? localToLatLon(m.track, z + lengthM / 2, x) : null),
      };
    }
  }

  /** Strip-own elevation at (s, u) in world y (markers sit on the strip that detected them). */
  ground(st, s, u) {
    return this.y(heightAt(st.model, s, u));
  }

  // ---------------------------------------------------------------- vehicle tracks
  buildTrack() {
    this.trackGroup = new THREE.Group();
    this.scene.add(this.trackGroup);
    for (const st of this.strips) {
      const tr = st.model.track;
      if (!tr?.s?.length) continue;
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tr.s.length * 3), 3));
      const mat = new THREE.LineBasicMaterial({ color: st.primary ? '#22d3ee' : '#7dd3fc', transparent: !st.primary, opacity: 0.6 });
      st.trackLine = new THREE.Line(lineGeo, mat);
      this.trackGroup.add(st.trackLine);
      this.disposables.push(lineGeo, mat);
      if (st.primary) {
        // "Curtain" of drop lines from the vehicle to the seabed: shows the survey altitude.
        st.dropEvery = Math.max(1, Math.round(tr.s.length / 40));
        const drops = Math.ceil(tr.s.length / st.dropEvery);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(drops * 6), 3));
        st.dropLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#67e8f9', transparent: true, opacity: 0.35 }));
        this.trackGroup.add(st.dropLines);
        this.disposables.push(g, st.dropLines.material);
      }
    }
    this.primary = this.strips[0];
    this.auv = createAUV().group;
    this.auv.visible = false;
    this.scene.add(this.auv);
    this.placeTrack();
  }

  vehicleAt(st, s) {
    const alt = altitudeAt(st.model.track, s) ?? 0;
    const p = st.map(s, 0);
    return new THREE.Vector3(p.x, this.y(heightAt(st.model, s, 0) + alt), p.z);
  }

  placeTrack() {
    for (const st of this.strips) {
      if (!st.trackLine) continue;
      const tr = st.model.track;
      const a = st.trackLine.geometry.attributes.position;
      const b = st.dropLines?.geometry.attributes.position;
      tr.s.forEach((s, i) => {
        const v = this.vehicleAt(st, s);
        a.setXYZ(i, v.x, v.y, v.z);
        if (b && i % st.dropEvery === 0) {
          const k = (i / st.dropEvery) * 2;
          b.setXYZ(k, v.x, v.y, v.z);
          b.setXYZ(k + 1, v.x, this.ground(st, s, 0), v.z);
        }
      });
      a.needsUpdate = true;
      st.trackLine.geometry.computeBoundingSphere();
      if (b) {
        b.needsUpdate = true;
        st.dropLines.geometry.computeBoundingSphere();
      }
    }
  }

  // ---------------------------------------------------------------- targets
  buildTargets() {
    this.targetGroup = new THREE.Group();
    this.scene.add(this.targetGroup);
    this.pinGeo = new THREE.SphereGeometry(1, 20, 14);
    this.disposables.push(this.pinGeo);
    this.targets = [];
    for (const st of this.strips) {
      for (const t of st.targets ?? []) {
        const key = `${st.scanId}:${t.detectionCode}`;
        const color = new THREE.Color(t.color);
        const pinMat = new THREE.MeshBasicMaterial({ color });
        const pin = new THREE.Mesh(this.pinGeo, pinMat);
        pin.userData.key = key;
        const stemGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
        const stem = new THREE.Line(stemGeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 }));
        const radius = Math.max(1.5, (t.sizeM ?? 3) / 2);
        const ringGeo = new THREE.RingGeometry(radius, radius + Math.min(1.2, Math.max(0.2, radius * 0.035)), 64);
        ringGeo.rotateX(-Math.PI / 2);
        const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide,
        }));
        ring.renderOrder = 2;
        const group = new THREE.Group();
        group.add(pin, stem, ring);
        this.targetGroup.add(group);
        this.disposables.push(pinMat, stemGeo, stem.material, ringGeo, ring.material);

        let tag = null;                                     // HTML label projected over the canvas
        if (this.labelsEl) {
          tag = document.createElement('button');
          tag.type = 'button';
          tag.className = 'seabed-tag';
          tag.title = `${st.name} · ${t.detectionCode}`;
          tag.style.setProperty('--tag', t.color);
          tag.innerHTML = `<i></i><span>${t.label}</span>${t.heightM != null ? `<b>${t.heightM.toFixed(1)} m</b>` : ''}`;
          tag.addEventListener('click', () => this.onSelect?.(key));
          this.labelsEl.appendChild(tag);
        }
        this.targets.push({ ...t, key, strip: st, group, pin, stem, ring, tag });
      }
    }
    this.placeTargets();
  }

  placeTargets() {
    for (const t of this.targets ?? []) {
      const p = t.strip.map(t.s, t.u);
      const g = this.ground(t.strip, t.s, t.u);
      const top = g + Math.max((t.heightM ?? 0) * this.exaggeration, 0) + Math.max(4, this.radius * 0.03);
      t.pin.position.set(p.x, top, p.z);
      const attr = t.stem.geometry.attributes.position;
      attr.setXYZ(0, p.x, g, p.z);
      attr.setXYZ(1, p.x, top, p.z);
      attr.needsUpdate = true;
      t.stem.geometry.computeBoundingSphere();
      t.ring.position.set(p.x, g + 0.15, p.z);
      t.anchor = new THREE.Vector3(p.x, top, p.z);
      t.base = new THREE.Vector3(p.x, g, p.z);
    }
    this.refreshTargets();
  }

  refreshTargets() {
    const r = Math.max(0.6, this.radius * 0.006);
    for (const t of this.targets ?? []) {
      const visible = this.showTargets && (t.status === 'confirmed' || this.includeSuppressed)
        && (!this.visibleClasses || this.visibleClasses.has(t.className));
      t.visible = visible;
      t.group.visible = visible;
      const sel = t.key === this.selected;
      t.pin.scale.setScalar(r * (sel ? 1.6 : t.strip.primary ? 1 : 0.8));
      t.ring.material.opacity = sel ? 1 : t.status === 'confirmed' ? 0.8 : 0.4;
      if (t.tag) {
        t.tag.classList.toggle('is-selected', sel);
        t.tag.classList.toggle('is-suppressed', t.status !== 'confirmed');
        t.tag.classList.toggle('is-neighbour', !t.strip.primary);
      }
    }
    this.dirty = true;
  }

  // ---------------------------------------------------------------- measuring
  buildMeasure() {
    this.measureGroup = new THREE.Group();
    this.scene.add(this.measureGroup);
    const dotMat = new THREE.MeshBasicMaterial({ color: '#f472b6', depthTest: false });
    this.measureDots = [0, 1].map(() => {
      const m = new THREE.Mesh(this.pinGeo, dotMat);
      m.renderOrder = 5;
      m.visible = false;
      this.measureGroup.add(m);
      return m;
    });
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(65 * 3), 3));
    this.measureLine = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: '#f472b6', depthTest: false }));
    this.measureLine.renderOrder = 5;
    this.measureLine.visible = false;
    this.measureGroup.add(this.measureLine);
    this.disposables.push(dotMat, lineGeo, this.measureLine.material);
  }

  /** Readout for a world (x, z): elevation, depth, lat/lon (and track-relative position when straightened). */
  pointInfo(x, z) {
    const h = this.field.height(x, z);
    const ll = this.field.latLon(x, z);
    const info = { x, z, h, depth: this.measured ? -h : null, ...(ll ?? {}) };
    if (!this.geo) Object.assign(info, { s: z + this.primaryModel.grid.lengthM / 2, u: x });
    return info;
  }

  placeMeasure() {
    const [a, b] = this.measurePts;
    const r = Math.max(0.5, this.radius * 0.006);
    this.measureDots.forEach((d, i) => {
      const p = this.measurePts[i];
      d.visible = Boolean(p);
      if (p) {
        d.position.set(p.x, this.y(this.field.height(p.x, p.z)) + r, p.z);
        d.scale.setScalar(r);
      }
    });
    this.measureLine.visible = Boolean(a && b);
    if (a && b) {
      const attr = this.measureLine.geometry.attributes.position;
      let last = this.field.height(a.x, a.z);
      for (let i = 0; i <= 64; i++) {
        const t = i / 64;
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        const h = this.field.height(x, z);
        if (!Number.isNaN(h)) last = h;
        attr.setXYZ(i, x, this.y(last) + r * 0.6, z);
      }
      attr.needsUpdate = true;
      this.measureLine.geometry.computeBoundingSphere();
    }
    this.dirty = true;
  }

  emitMeasure() {
    const [a, b] = this.measurePts;
    if (!a || !b) return this.onMeasure?.(a ? { a: this.pointInfo(a.x, a.z) } : null);
    const pa = this.pointInfo(a.x, a.z);
    const pb = this.pointInfo(b.x, b.z);
    const horizontal = Math.hypot(b.x - a.x, b.z - a.z);
    const dh = pb.h - pa.h;
    const profile = [];
    for (let i = 0; i <= 64; i++) {
      const t = i / 64;
      const h = this.field.height(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      if (!Number.isNaN(h)) profile.push({ d: horizontal * t, h });
    }
    const lowest = profile.reduce((m, p) => (p.h < m.h ? p : m), profile[0]);
    const highest = profile.reduce((m, p) => (p.h > m.h ? p : m), profile[0]);
    this.onMeasure?.({
      a: pa,
      b: pb,
      horizontal,
      distance: Math.hypot(horizontal, dh),
      dh,
      slopeDeg: (Math.atan2(Math.abs(dh), horizontal) * 180) / Math.PI,
      bearingDeg: this.geo ? ((Math.atan2(b.x - a.x, -(b.z - a.z)) * 180) / Math.PI + 360) % 360 : null,
      reliefM: highest && lowest ? highest.h - lowest.h : null,
      profile,
    });
  }

  clearMeasure() {
    this.measurePts = [];
    this.placeMeasure();
    this.onMeasure?.(null);
  }

  // ---------------------------------------------------------------- input
  bindEvents() {
    const el = this.renderer.domElement;
    let down = null;
    this.handlers = {
      pointerdown: (e) => { down = { x: e.clientX, y: e.clientY }; },
      pointerup: (e) => {
        if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
        down = null;
        this.click(e);
      },
      pointermove: (e) => {
        this.lastMove = e;
        this.pointerDirty = true;
      },
      pointerleave: () => {
        this.lastMove = null;
        this.onPointer?.(null);
        el.style.cursor = '';
      },
    };
    for (const [k, fn] of Object.entries(this.handlers)) el.addEventListener(k, fn);
  }

  setRay(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  /** Ray-march the elevation field (much cheaper than testing every triangle of the meshes). */
  hitTerrain() {
    const ray = this.raycaster.ray;
    const { minX, maxX, minZ, maxZ } = this.field.bounds;
    const box = new THREE.Box3(
      new THREE.Vector3(minX, this.y(this.elevRange[0]) - 1, minZ),
      new THREE.Vector3(maxX, this.y(this.elevRange[1]) + 1, maxZ),
    );
    const entry = box.containsPoint(ray.origin) ? ray.origin.clone() : ray.intersectBox(box, new THREE.Vector3());
    if (!entry) return null;
    const step = Math.max(0.05, Math.min(...this.strips.map((s) => s.cellM)) * 0.7);
    const below = (q) => {
      const h = this.field.height(q.x, q.z);
      return !Number.isNaN(h) && q.y <= this.y(h);
    };
    const p = entry.clone();
    if (below(p)) return { x: p.x, z: p.z };
    const maxSteps = Math.ceil((4 * this.radius + box.max.y - box.min.y) / step) + 2;
    const prev = new THREE.Vector3();
    for (let i = 0; i < maxSteps; i++) {
      prev.copy(p);
      p.addScaledVector(ray.direction, step);
      if (!box.containsPoint(p)) return null;
      if (below(p)) {
        const lo = prev.clone();
        const hi = p.clone();
        for (let k = 0; k < 10; k++) {
          const mid = lo.clone().lerp(hi, 0.5);
          if (below(mid)) hi.copy(mid);
          else lo.copy(mid);
        }
        return { x: hi.x, z: hi.z };
      }
    }
    return null;
  }

  hitTarget() {
    const pins = (this.targets ?? []).filter((t) => t.visible).map((t) => t.pin);
    const hit = this.raycaster.intersectObjects(pins, false)[0];
    return hit?.object.userData.key ?? null;
  }

  click(e) {
    this.setRay(e);
    if (this.tool === 'measure') {
      const p = this.hitTerrain();
      if (!p) return;
      this.measurePts = this.measurePts.length >= 2 ? [p] : [...this.measurePts, p];
      this.placeMeasure();
      this.emitMeasure();
      return;
    }
    const key = this.hitTarget();
    if (key) this.onSelect?.(key);
  }

  hover() {
    if (!this.pointerDirty || !this.lastMove || this.anim) return;
    this.pointerDirty = false;
    this.setRay(this.lastMove);
    const key = this.tool === 'orbit' ? this.hitTarget() : null;
    const p = this.hitTerrain();
    this.renderer.domElement.style.cursor = key ? 'pointer' : this.tool === 'measure' && p ? 'crosshair' : '';
    this.onPointer?.(p ? this.pointInfo(p.x, p.z) : null);
  }

  // ---------------------------------------------------------------- settings (called by React)
  setExaggeration(x) {
    if (!this.strips || x === this.exaggeration) return;
    this.exaggeration = x;
    this.applyHeights();
    this.placeTrack();
    this.placeTargets();
    this.placeMeasure();
    if (this.followT !== null) this.setFollow(this.followT);
  }

  setColorMode(mode) {
    if (this.common) this.common.uMode.value = MODES[mode] ?? 0;
    this.dirty = true;
  }

  setContours(on) {
    if (this.common) this.common.uContours.value = on ? 1 : 0;
    this.dirty = true;
  }

  setCoverage(on) {
    if (this.common) this.common.uCoverage.value = on ? 1 : 0;
    this.dirty = true;
  }

  setShowTrack(on) {
    if (this.trackGroup) this.trackGroup.visible = on;
    this.dirty = true;
  }

  setTargetFilter({ show, classes, includeSuppressed }) {
    this.showTargets = show;
    this.visibleClasses = classes ? new Set(classes) : null;
    this.includeSuppressed = includeSuppressed;
    if (this.targets) this.refreshTargets();
  }

  setTool(tool) {
    this.tool = tool;
    if (tool !== 'measure' && this.measurePts.length) this.clearMeasure();
  }

  setSelected(key) {
    this.selected = key;
    if (this.targets) this.refreshTargets();
  }

  // ---------------------------------------------------------------- camera
  animateTo(pos, target, ms = 900) {
    this.anim = { from: { pos: this.camera.position.clone(), target: this.controls.target.clone() }, to: { pos, target }, t0: performance.now(), ms };
  }

  view(preset, animate = true) {
    if (!this.controls) return;
    this.setFollow(null);
    const R = this.radius;
    const dist = (R / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.05;
    const target = this.center.clone();
    let dir;
    if (preset === 'along') {
      // from behind the start of the selected line, looking along its track
      const a = this.primary.map(0, 0);
      const b = this.primary.map(this.primaryModel.grid.lengthM, 0);
      const fwd = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize();
      dir = fwd.clone().multiplyScalar(-1).add(new THREE.Vector3(0, 0.35, 0)).add(new THREE.Vector3(fwd.z, 0, -fwd.x).multiplyScalar(0.12));
    } else {
      dir = {
        oblique: this.geo ? new THREE.Vector3(0.45, 0.62, 0.62) : new THREE.Vector3(0.62, 0.62, 0.48),
        top: new THREE.Vector3(0, 1, 0.0001),
        side: this.geo ? new THREE.Vector3(0.0001, 0.18, 1) : new THREE.Vector3(1, 0.18, 0.0001),
      }[preset] ?? new THREE.Vector3(0.62, 0.62, 0.48);
    }
    const pos = target.clone().add(dir.normalize().multiplyScalar(preset === 'side' ? dist * 0.8 : dist));
    if (animate) this.animateTo(pos, target);
    else {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
    }
    this.dirty = true;
  }

  flyTo(key) {
    const t = this.targets?.find((x) => x.key === key);
    if (!t || !this.controls) return;
    this.setFollow(null);
    const target = t.base.clone();
    // far enough to see the whole target, including its (exaggerated) height
    const back = Math.max(18, (t.sizeM ?? 5) * 1.6, (t.heightM ?? 0) * this.exaggeration * 3);
    const toCam = this.camera.position.clone().sub(target).setY(0);
    if (toCam.lengthSq() < 1e-6) toCam.set(1, 0, 1);
    toCam.normalize().multiplyScalar(back);
    this.animateTo(target.clone().add(new THREE.Vector3(toCam.x, back * 0.75, toCam.z)), target);
  }

  /** Ride along the selected line's track: t in [0, 1], or null to return to orbiting. */
  setFollow(t) {
    this.followT = t;
    if (!this.auv) return;
    this.auv.visible = t !== null;
    if (this.controls) this.controls.enabled = t === null;
    if (t === null) { this.dirty = true; return; }
    this.anim = null;
    const st = this.primary;
    const L = st.model.grid.lengthM;
    const s = t * L;
    const v = this.vehicleAt(st, s);
    const ahead = this.vehicleAt(st, Math.min(L, s + 1));
    const fwd = ahead.clone().sub(v).setY(0).normalize();
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
    this.auv.position.copy(v);
    this.auv.lookAt(v.x + fwd.x, v.y, v.z + fwd.z);
    const scale = Math.max(1, this.exaggeration * 0.6);
    this.auv.scale.setScalar(scale);
    // Chase camera: a little behind, above and to starboard, looking ahead and down towards the seabed.
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const below = v.y - this.ground(st, s, 0);
    this.camera.position.copy(v).addScaledVector(fwd, -13 * scale).addScaledVector(right, 4 * scale).add(new THREE.Vector3(0, 3.5 * scale, 0));
    this.controls.target.copy(v).addScaledVector(fwd, 14 * scale).add(new THREE.Vector3(0, -0.45 * below, 0));
    this.camera.lookAt(this.controls.target);
    this.dirty = true;
  }

  // ---------------------------------------------------------------- frame
  resize() {
    if (!this.renderer) return;
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  updateLabels() {
    if (!this.targets?.length) return;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const v = new THREE.Vector3();
    for (const t of this.targets) {
      if (!t.tag) continue;
      v.copy(t.anchor).project(this.camera);
      const on = t.visible && v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      t.tag.style.display = on ? '' : 'none';
      if (on) t.tag.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
    }
  }

  /** North arrow (true geometry) or track-direction arrow (straightened), and a scale bar. */
  updateOverlay() {
    const { arrow, scaleBar, scaleText } = this.overlay;
    const e = this.camera.matrixWorld.elements;
    // screen "up" on the ground plane: camera up + forward, projected on x/z (works from the top and from the side)
    const ux = e[4] - e[8];
    const uz = e[6] - e[10];
    const screenUp = Math.atan2(ux, -uz);                  // 0 when screen-up points north (-z)
    const ref = this.geo ? 0 : Math.PI;                   // straightened: arrow shows the track direction (+z)
    if (arrow) arrow.style.transform = `rotate(${((ref - screenUp) * 180) / Math.PI}deg)`;
    if (scaleBar && scaleText) {
      const dist = this.camera.position.distanceTo(this.controls.target);
      const mpp = (2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / Math.max(this.host.clientHeight, 1);
      const len = niceLength(110 * mpp);
      scaleBar.style.width = `${Math.round(len / mpp)}px`;
      scaleText.textContent = len >= 1000 ? `${len / 1000} km` : `${len} m`;
    }
  }

  loop(now) {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (this.anim) {
      const k = Math.min(1, (now - this.anim.t0) / this.anim.ms);
      const e = ease(k);
      this.camera.position.lerpVectors(this.anim.from.pos, this.anim.to.pos, e);
      this.controls.target.lerpVectors(this.anim.from.target, this.anim.to.target, e);
      if (k >= 1) this.anim = null;
      this.dirty = true;
    }
    if (this.followT === null) this.controls.update();
    this.hover();
    if (!this.dirty) return;
    this.dirty = false;
    if (this.followT === null) this.camera.lookAt(this.controls.target);
    this.renderer.render(this.scene, this.camera);
    this.updateLabels();
    this.updateOverlay();
  }

  /** PNG of the current view with the target labels and a caption burnt in (for reports). */
  snapshot(caption) {
    this.renderer.render(this.scene, this.camera);
    const src = this.renderer.domElement;
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const k = src.width / Math.max(this.host.clientWidth, 1);
    ctx.font = `600 ${Math.round(11 * k)}px ui-monospace, Menlo, monospace`;
    ctx.textBaseline = 'middle';
    const v = new THREE.Vector3();
    for (const t of this.targets ?? []) {
      if (!t.visible) continue;
      v.copy(t.anchor).project(this.camera);
      if (v.z >= 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) continue;
      const x = ((v.x + 1) / 2) * out.width;
      const y = ((1 - v.y) / 2) * out.height - 16 * k;
      const text = `${t.label}${t.heightM != null ? ` ${t.heightM.toFixed(1)} m` : ''}`;
      const w = ctx.measureText(text).width + 18 * k;
      ctx.fillStyle = 'rgba(8,18,33,0.85)';
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - 9 * k, w, 18 * k, 9 * k);
      ctx.fill();
      ctx.fillStyle = t.color;
      ctx.beginPath();
      ctx.arc(x - w / 2 + 8 * k, y, 3.5 * k, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(text, x - w / 2 + 14 * k, y);
    }
    if (caption) {
      ctx.fillStyle = 'rgba(8,18,33,0.8)';
      ctx.fillRect(0, out.height - 26 * k, out.width, 26 * k);
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText(caption, 10 * k, out.height - 13 * k);
    }
    return out.toDataURL('image/png');
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.controls?.dispose();
    if (this.renderer && this.handlers) {
      for (const [k, fn] of Object.entries(this.handlers)) this.renderer.domElement.removeEventListener(k, fn);
    }
    for (const t of this.targets ?? []) t.tag?.remove();
    this.auv?.traverse((o) => {
      o.geometry?.dispose();
      if (o.material) [].concat(o.material).forEach((m) => { m.map?.dispose(); m.dispose(); });
    });
    for (const d of this.disposables) d.dispose();
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
  }
}
