/**
 * The hero's underwater survey: an AUV flies a side-scan line, the seabed behind it turns into the sonar
 * image it records, targets are detected, geotagged and reported. Everything is a pure function of the loop
 * time, so the story is deterministic (and `?heroT=12` freezes any moment for a screenshot).
 */
import * as THREE from 'three';
import { CLASS_TINT, LOOP_S, PHASES, SURVEY, TARGETS, formatLatLon, phaseIndexAt, toLatLon, vehicleZ } from '../storyline';
import { clamp01, ease, mulberry32, smoothstep } from './noise';
import {
  createBeaconMaterial, createEnvMaterial, createFanMaterial, createRayMaterial, createRingMaterial,
  createSeabedMaterial, createSnowMaterial,
} from './materials';
import { createAircraft, createAUV, createFans, createFishSchool, createGhostNet, createMine, createPipe, createRocks, createWreck } from './models';
import {
  SEABED, SONAR_STEP, WATERFALL_HALF, bakeSeabedDetail, buildSeabedFields, rasterizeObject, scatterRocks,
  simulateSideScan, sonarGeometry, vehicleY, waterfallBox,
} from './world';

const FOG_COLOR = '#0a3346';
const EXPOSURE = 1.05;
const PING_PERIOD = 0.55;
const FOV = 38;
const OVERVIEW = [20.2, 25.6]; // crane up to the map view
const STILL_TIME = 27.6; // the frame shown with prefers-reduced-motion
const WATERFALL_ROWS = 260; // pings visible in the live waterfall (~42 m of track)

// Camera: offsets from the vehicle while tracking (z = distance ahead), then an absolute overview.
const TRACK_POS = new THREE.Vector3(18, 10, 30);
const TRACK_LOOK = new THREE.Vector3(0, -4, -2);
const OVER_POS = new THREE.Vector3(0, 115, 95);
const OVER_LOOK = new THREE.Vector3(0, 0, -21);

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

export default class OceanScene {
  constructor({ host, labels, waterfall, telemetry = {}, stepper, onPhase, freezeAt = null, still = false }) {
    Object.assign(this, { host, labelLayer: labels, wfCanvas: waterfall, telemetry, stepper, onPhase, freezeAt, still });
    this.time = freezeAt ?? (still ? STILL_TIME : 0);
    this.phase = -1;
    this.running = false;
    this.inView = true;
    this.disposed = false;
    this.frames = 0;
    this.frameTime = 0;
    this.lastTelemetry = -1;
    this.frozenFrames = 0;
    // Mouse parallax: target and eased pointer position, both in [-1, 1].
    this.pointer = { x: 0, y: 0, tx: 0, ty: 0, last: 0 };
    this.v = { pos: new THREE.Vector3(), look: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3() };
  }

  // ------------------------------------------------------------------------------------------ build

  async build() {
    const canvas = document.createElement('canvas');
    canvas.className = 'ocean-canvas';
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer = renderer;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = EXPOSURE;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, window.innerWidth < 768 ? 1.25 : 1.5);
    renderer.setPixelRatio(this.pixelRatio);
    renderer.setClearColor(FOG_COLOR);
    this.host.appendChild(canvas);

    const scene = new THREE.Scene();
    this.scene = scene;
    scene.fog = new THREE.FogExp2(FOG_COLOR, 0.034);
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.3, 520);

    const sunDir = new THREE.Vector3(0.28, 1, 0.18).normalize();
    const lights = {
      sunDir,
      sunColor: new THREE.Color('#bfe7ff').multiplyScalar(1.35),
      skyAmbient: new THREE.Color('#2d7ea3'),
      groundAmbient: new THREE.Color('#0b1f2b'),
    };
    const sun = new THREE.DirectionalLight('#cdeeff', 1.9);
    sun.position.copy(sunDir).multiplyScalar(80);
    scene.add(new THREE.HemisphereLight('#6fc0e2', '#0b2130', 1.25), sun);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), createEnvMaterial()));
    this.envRT = pmrem.fromScene(envScene, 0.03);
    scene.environment = this.envRT.texture;
    scene.environmentIntensity = 0.75;
    pmrem.dispose();

    // Seabed geometry on the shared 1 m height grid.
    this.fields = buildSeabedFields();
    this.heights = this.fields.heights;
    this.terrainAt = this.fields.heightAt;
    const seabedGeo = new THREE.PlaneGeometry(SEABED.maxX - SEABED.minX, SEABED.maxZ - SEABED.minZ, this.heights.nx - 1, this.heights.nz - 1);
    seabedGeo.rotateX(-Math.PI / 2);
    seabedGeo.translate((SEABED.minX + SEABED.maxX) / 2, 0, (SEABED.minZ + SEABED.maxZ) / 2);
    const sp = seabedGeo.attributes.position;
    for (let i = 0; i < sp.count; i++) sp.setY(i, this.terrainAt(sp.getX(i), sp.getZ(i)));
    seabedGeo.computeVertexNormals();

    // Targets, rocks and the fish school.
    this.targets = [];
    for (const [order, data] of TARGETS.entries()) {
      const object = this.makeTarget(data);
      if (object) scene.add(object);
      this.targets.push({ data, object, order });
    }
    this.rockField = createRocks(scatterRocks(), this.terrainAt);
    scene.add(this.rockField);
    this.school = createFishSchool(window.innerWidth < 768 ? 45 : 70);
    scene.add(this.school.mesh);
    const fishTarget = TARGETS.find((t) => t.kind === 'fish');
    this.fishCentre = new THREE.Vector3(fishTarget.x, this.terrainAt(fishTarget.x, fishTarget.z) + 4.6, fishTarget.z);
    this.fishBox = new THREE.Box3();
    this.dummy = new THREE.Object3D();

    // Bake the seabed detail (sediment tone, contact shadows, ripples) and simulate the sonar line.
    await pause();
    if (this.disposed) return;
    const rasterizeAll = (grid, ids) => {
      for (const t of this.targets) if (t.object) rasterizeObject(t.object, grid, ids, t.object.userData.sonarId ?? 1);
      rasterizeObject(this.rockField, grid, ids, 2);
    };
    const detail = bakeSeabedDetail(rasterizeAll, this.fields);
    const detailTex = new THREE.DataTexture(detail.data, detail.width, detail.height, THREE.RGBAFormat);
    this.prepareDataTexture(detailTex);
    await pause();
    if (this.disposed) return;

    const echoes = this.school.fish.map((f) => this.fishPosition(f, fishTarget.detectAt - 1.2, new THREE.Vector3()));
    const sonar = await simulateSideScan(rasterizeAll, this.fields, echoes);
    if (this.disposed) return;
    const sonarTex = new THREE.DataTexture(sonar.drape, sonar.width, sonar.height, THREE.RedFormat, THREE.UnsignedByteType);
    sonarTex.unpackAlignment = 1;
    this.prepareDataTexture(sonarTex);
    this.sonarGeo = sonarGeometry();
    const wf = document.createElement('canvas');
    wf.width = sonar.waterfall.width;
    wf.height = sonar.waterfall.height;
    wf.getContext('2d').putImageData(new ImageData(sonar.waterfall.pixels, wf.width, wf.height), 0, 0);
    this.wfImage = wf;
    this.wfBoxes = TARGETS.map((t) => waterfallBox(t, sonar.altitude));
    this.wfCtx = this.wfCanvas?.getContext('2d') ?? null;

    this.seabedMat = createSeabedMaterial({
      detail: { texture: detailTex, rect: detail.rect },
      sonar: { texture: sonarTex, rect: sonar.rect },
      lights,
    });
    this.seabedMat.uniforms.uRange.value = SURVEY.range;
    scene.add(new THREE.Mesh(seabedGeo, this.seabedMat));

    // The vehicle and its two sonar fans.
    this.auv = createAUV();
    scene.add(this.auv.group);
    this.fanMat = createFanMaterial();
    createFans(this.fanMat, { altitude: SURVEY.altitude, range: SURVEY.range }).forEach((fan, i) => {
      const t = this.auv.transducer;
      fan.position.set(i === 0 ? t.x : -t.x, t.y, t.z);
      this.auv.group.add(fan);
    });

    this.buildAtmosphere();
    this.buildMarkers();
    // Compile shaders off the main thread where supported, so the first frame does not hitch.
    await this.renderer.compileAsync?.(this.scene, this.camera);
    if (this.disposed) return;
    this.buildLabels();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.io = new IntersectionObserver(([entry]) => {
      this.inView = entry.isIntersecting;
      this.syncRunning();
    });
    this.io.observe(this.host);
    this.onVisibility = () => this.syncRunning();
    document.addEventListener('visibilitychange', this.onVisibility);
    if (this.freezeAt == null && !this.still) {
      this.onPointer = (e) => {
        if (e.pointerType === 'touch') return;
        const r = this.host.getBoundingClientRect();
        this.pointer.tx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
        this.pointer.ty = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
      };
      this.onPointerLeave = () => {
        this.pointer.tx = 0;
        this.pointer.ty = 0;
      };
      window.addEventListener('pointermove', this.onPointer, { passive: true });
      document.documentElement.addEventListener('pointerleave', this.onPointerLeave);
      window.addEventListener('blur', this.onPointerLeave);
    }
    this.resize();
  }

  prepareDataTexture(texture) {
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
  }

  makeTarget(t) {
    const yaw = THREE.MathUtils.degToRad(t.heading - 90);
    const ground = this.terrainAt(t.x, t.z);
    let object = null;
    if (t.kind === 'wreck') {
      object = createWreck();
      object.position.set(t.x, ground + 1.75, t.z);
      object.rotation.set(0.3, yaw, -0.04, 'YXZ');
    } else if (t.kind === 'aircraft') {
      object = createAircraft();
      object.position.set(t.x, ground + 0.34, t.z);
      object.rotation.set(0.2, yaw, -0.07, 'YXZ');
    } else if (t.kind === 'mine') {
      object = createMine();
      object.position.set(t.x, ground + 0.3, t.z);
      object.rotation.set(0.25, yaw, 0.02, 'YXZ');
    } else if (t.kind === 'pipe') {
      object = createPipe();
      object.position.set(t.x, ground + 0.12, t.z);
      object.rotation.set(0.15, yaw, 0.01, 'YXZ');
    } else if (t.kind === 'net') {
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);
      object = createGhostNet((lx, lz) => this.terrainAt(t.x + lx * cos + lz * sin, t.z - lx * sin + lz * cos) - ground);
      object.position.set(t.x, ground, t.z);
      object.rotation.y = yaw;
    }
    return object;
  }

  buildAtmosphere() {
    const rnd = mulberry32(7);
    const count = window.innerWidth < 768 ? 1200 : 2400;
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions.set([(rnd() - 0.5) * 70, (rnd() - 0.5) * 34, (rnd() - 0.5) * 90], i * 3);
      sizes[i] = 0.03 + rnd() * rnd() * 0.1;
      seeds[i] = rnd();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    this.snowMat = createSnowMaterial();
    const snow = new THREE.Points(geo, this.snowMat);
    snow.frustumCulled = false;
    this.scene.add(snow);

    this.rays = [];
    for (let k = 0; k < 7; k++) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), createRayMaterial(k * 1.37));
      mesh.scale.set(4 + rnd() * 9, 64, 1);
      mesh.userData = { dx: (k - 3) * 12 + (rnd() - 0.5) * 6, dz: -8 - rnd() * 60, lean: 0.12 + rnd() * 0.08 };
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.rays.push(mesh);
    }
  }

  buildMarkers() {
    for (const t of this.targets) {
      const d = t.data;
      const tint = CLASS_TINT[d.cls];
      const ground = this.terrainAt(d.x, d.z);
      const radius = Math.max(...d.dims) / 2 + 1.2;
      const size = radius * 2 + 4;
      const geo = new THREE.PlaneGeometry(size, size, 28, 28).rotateX(-Math.PI / 2);
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) p.setY(i, this.terrainAt(d.x + p.getX(i), d.z + p.getZ(i)) - ground + 0.14);
      const ring = new THREE.Mesh(geo, createRingMaterial(tint));
      ring.position.set(d.x, ground, d.z);
      ring.renderOrder = 4;
      ring.userData.radius = radius;
      this.scene.add(ring);
      t.ring = ring;

      if (!d.filtered) {
        const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.34, 18, 16, 1, true), createBeaconMaterial(tint));
        beacon.position.set(d.x, ground + 9, d.z);
        beacon.renderOrder = 5;
        this.scene.add(beacon);
        t.beacon = beacon;
      }

      if (t.object) t.box = new THREE.Box3().setFromObject(t.object);
      else if (d.kind === 'rocks') {
        const h = (d.heading * Math.PI) / 180;
        const across = Math.abs(d.dims[0] * Math.sin(h)) + Math.abs(d.dims[1] * Math.cos(h));
        const along = Math.abs(d.dims[0] * Math.cos(h)) + Math.abs(d.dims[1] * Math.sin(h));
        t.box = new THREE.Box3(new THREE.Vector3(d.x - across / 2, ground - 0.3, d.z - along / 2), new THREE.Vector3(d.x + across / 2, ground + 1.9, d.z + along / 2));
      } else t.box = this.fishBox;
    }
  }

  buildLabels() {
    if (!this.labelLayer) return;
    this.tagEls = [];
    for (const t of this.targets) {
      const d = t.data;
      const el = document.createElement('div');
      el.className = `ocean-tag${d.filtered ? ' is-filtered' : ''}`;
      el.style.setProperty('--tint', CLASS_TINT[d.cls]);
      const geo = d.filtered ? `Filtered · ${d.filtered}` : `${formatLatLon(d)} · ${d.dims[0]} × ${d.dims[1]} m`;
      el.innerHTML = `
        <div class="ocean-tag__box"><i></i><i></i><i></i><i></i></div>
        <div class="ocean-tag__label">
          <div class="ocean-tag__row">
            <span class="ocean-tag__dot"></span>${d.id ? `<span class="ocean-tag__id">${d.id}</span>` : ''}
            <span class="ocean-tag__name">${d.label}</span><b class="ocean-tag__conf">0.0%</b>
          </div>
          <div class="ocean-tag__geo">${geo}</div>
        </div>`;
      this.labelLayer.appendChild(el);
      this.tagEls.push(el);
      Object.assign(t, { el, boxEl: el.firstElementChild, confEl: el.querySelector('.ocean-tag__conf'), shown: false, geo: false, rejected: false, confText: '' });
    }
  }

  // ------------------------------------------------------------------------------------------ lifecycle

  resize() {
    if (this.disposed) return;
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    // Lens shift: keep the action clear of the headline without changing the shot: to the right on wide
    // screens, above the text on portrait ones.
    const sx = aspect > 1.15 ? Math.min(0.17, (aspect - 1.15) * 0.3) * w : 0;
    const sy = aspect < 0.9 ? 0.2 * h : 0;
    const fullW = w + 2 * sx;
    const fullH = h + 2 * sy;
    this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(FOV) / 2) * (fullH / h)));
    this.camera.aspect = fullW / fullH;
    this.camera.setViewOffset(fullW, fullH, 0, 2 * sy, w, h);
    this.camera.updateProjectionMatrix();
    this.framing = aspect < 0.8 ? 1.55 : aspect < 1.2 ? 1.25 : 1;
    this.snowMat.uniforms.uScale.value = (h * this.renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(FOV) / 2));
    if (this.wfCanvas && this.wfCtx) {
      const r = Math.min(window.devicePixelRatio || 1, 2);
      this.wfW = this.wfCanvas.clientWidth || 320;
      this.wfH = this.wfCanvas.clientHeight || 176;
      this.wfCanvas.width = Math.round(this.wfW * r);
      this.wfCanvas.height = Math.round(this.wfH * r);
      this.wfCtx.setTransform(r, 0, 0, r, 0, 0);
    }
    if (!this.running) this.renderFrame();
  }

  start() {
    this.wanted = true;
    this.syncRunning();
    if (this.still) this.renderFrame();
  }

  syncRunning() {
    const go = this.wanted && !this.still && !this.disposed && this.inView && !document.hidden;
    if (go && !this.running) {
      this.running = true;
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.tick);
    } else if (!go && this.running) {
      this.running = false;
      cancelAnimationFrame(this.raf);
    }
  }

  tick = (now) => {
    if (!this.running) return;
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    if (this.freezeAt == null) this.time = (this.time + dt) % LOOP_S;
    this.renderFrame();
    this.adaptQuality(dt);
    // A frozen scene only needs a few frames; stopping leaves a stable page for screenshots.
    if (this.freezeAt != null && ++this.frozenFrames > 20) {
      this.running = false;
      return;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  adaptQuality(dt) {
    this.frames += 1;
    this.frameTime += dt;
    if (this.frames < 120) return;
    const avg = this.frameTime / this.frames;
    this.frames = 0;
    this.frameTime = 0;
    if (avg > 0.024 && this.pixelRatio > 0.8) {
      this.pixelRatio = Math.max(0.75, this.pixelRatio - 0.25);
      this.renderer.setPixelRatio(this.pixelRatio);
      this.resize();
    }
  }

  renderFrame() {
    if (this.disposed || !this.seabedMat) return;
    this.update(this.time);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.io?.disconnect();
    if (this.onVisibility) document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.onPointer) {
      window.removeEventListener('pointermove', this.onPointer);
      document.documentElement.removeEventListener('pointerleave', this.onPointerLeave);
      window.removeEventListener('blur', this.onPointerLeave);
    }
    this.scene?.traverse((o) => {
      o.geometry?.dispose();
      const materials = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of materials) {
        for (const value of Object.values(m)) if (value?.isTexture) value.dispose();
        for (const u of Object.values(m.uniforms ?? {})) if (u.value?.isTexture) u.value.dispose();
        m.dispose();
      }
    });
    this.envRT?.dispose();
    this.renderer?.dispose();
    this.canvas?.remove();
    this.tagEls?.forEach((el) => el.remove());
  }

  // ------------------------------------------------------------------------------------------ frame

  update(t) {
    const zV = vehicleZ(t);
    const yV = vehicleY(zV);
    const overview = ease(OVERVIEW[0], OVERVIEW[1], t);
    const dark = Math.max(1 - ease(0, 1.4, t), ease(LOOP_S - 1.6, LOOP_S - 0.05, t));

    // Vehicle: a steady glide with small pitch / roll corrections.
    const g = this.auv.group;
    g.position.set(0, yV + 0.06 * Math.sin(t * 0.9), zV);
    g.rotation.set(0.012 * Math.sin(t * 0.5 + 1), 0, 0.02 * Math.sin(t * 0.7));
    this.auv.prop.rotation.z = -t * 24;
    const flash = t % 1.7 < 0.09 ? 1 : 0;
    this.auv.glow.material.opacity = 0.08 + 0.92 * flash;
    this.auv.strobe.material.color.setScalar(0.35 + 0.65 * flash);

    // Sonar: fans, ping front on the seabed and the image draped behind the vehicle.
    const sonarOn = smoothstep(SURVEY.scanOnZ - 1, SURVEY.scanOnZ + 2, zV) * (1 - smoothstep(SURVEY.scanOffZ - 2, SURVEY.scanOffZ + 0.5, zV));
    const ping = (t % PING_PERIOD) / PING_PERIOD;
    this.fanMat.uniforms.uPhase.value = ping;
    this.fanMat.uniforms.uOn.value = sonarOn * (1 - dark);
    const u = this.seabedMat.uniforms;
    u.uTime.value = t;
    u.uScanZ.value = Math.min(Math.max(zV, SURVEY.scanOnZ - 1), SURVEY.scanOffZ);
    u.uPing.value = ping;
    u.uPingOn.value = sonarOn;
    u.uPool.value.set(0, 0.35 * (1 - 0.7 * overview), zV + 3.2);
    u.uGrid.value = overview;
    u.uCaustics.value = 1 - 0.7 * overview;

    this.updateCamera(t, zV, yV, overview);
    const baseFog = 0.03 + (0.016 - 0.03) * ease(0, 3.5, t);
    this.scene.fog.density = baseFog + (0.003 - baseFog) * overview;
    this.renderer.toneMappingExposure = EXPOSURE * (1 - 0.97 * dark);

    // Atmosphere.
    const look = this.v.look;
    const cam = this.camera.position;
    this.snowMat.uniforms.uTime.value = t;
    this.snowMat.uniforms.uCenter.value.copy(cam).lerp(look, 0.5);
    this.snowMat.uniforms.uFogDensity.value = Math.max(this.scene.fog.density, 0.012);
    this.snowMat.uniforms.uOpacity.value = 0.55 * (1 - 0.6 * overview);
    for (const ray of this.rays) {
      const { dx, dz, lean } = ray.userData;
      const x = look.x + dx;
      const z = look.z + dz;
      ray.position.set(x, 26, z);
      ray.rotation.set(0, Math.atan2(cam.x - x, cam.z - z), lean);
      ray.material.uniforms.uTime.value = t;
      ray.material.uniforms.uOpacity.value = 0.055 * (1 - overview) * (1 - dark);
      ray.material.uniforms.uFogDensity.value = this.scene.fog.density;
    }

    this.updateFish(t);
    this.updateTargets(t, overview, dark);
    this.updateHud(t, zV, yV);

    const index = phaseIndexAt(t);
    if (index !== this.phase) {
      this.phase = index;
      this.onPhase?.(index);
    }
    if (this.stepper) {
      const start = PHASES[index].start;
      const end = PHASES[index + 1]?.start ?? LOOP_S;
      const progress = this.still ? 1 : clamp01((t - start) / (end - start));
      this.stepper.style.setProperty('--phase-progress', progress.toFixed(3));
    }
  }

  updateCamera(t, zV, yV, overview) {
    const { pos, look, a } = this.v;
    const k = this.framing;
    const approach = clamp01(t / 6.5);
    const ahead = (TRACK_POS.z + 24 * (1 - approach) ** 2) * k;
    pos.set(TRACK_POS.x * k + Math.sin(t * 0.31) * 0.5, yV + TRACK_POS.y * k + Math.sin(t * 0.23 + 1) * 0.3, zV + ahead);
    look.set(TRACK_LOOK.x, yV + TRACK_LOOK.y, zV + TRACK_LOOK.z);
    if (overview > 0) {
      a.set(OVER_POS.x + Math.sin(t * 0.08) * 3, OVER_POS.y * (k > 1 ? 1.3 : 1), OVER_POS.z);
      pos.lerp(a, overview);
      look.lerp(OVER_LOOK, overview);
    }
    this.applyParallax(pos, look);
    this.camera.position.copy(pos);
    this.camera.lookAt(look);
    this.camera.updateMatrixWorld();
  }

  /** Nudge the camera towards the mouse: it slides a little and turns less, so near things shift more. */
  applyParallax(pos, look) {
    const p = this.pointer;
    const now = performance.now();
    const dt = p.last ? Math.min((now - p.last) / 1000, 0.1) : 0;
    p.last = now;
    const follow = 1 - Math.exp(-dt * 5.5);
    p.x += (p.tx - p.x) * follow;
    p.y += (p.ty - p.y) * follow;
    if (Math.abs(p.x) < 1e-4 && Math.abs(p.y) < 1e-4) return;
    const { a, b } = this.v;
    const forward = a.subVectors(look, pos);
    const reach = forward.length() * 0.2; // ~2 m while tracking, more on the map view
    const right = b.crossVectors(forward, this.camera.up).normalize();
    const up = forward.crossVectors(right, forward).normalize();
    pos.addScaledVector(right, p.x * reach).addScaledVector(up, -p.y * reach * 0.6);
    look.addScaledVector(right, p.x * reach * 0.35).addScaledVector(up, -p.y * reach * 0.2);
  }

  fishPosition(f, t, out) {
    const c = this.fishCentre;
    const angle = f.angle + f.speed * t;
    return out.set(
      c.x + Math.cos(angle) * f.radius + Math.sin(t * 0.13) * 0.8,
      c.y + f.height + 0.25 * Math.sin(t * 0.9 + f.wobble),
      c.z + Math.sin(angle) * f.radius + Math.cos(t * 0.11) * 0.8,
    );
  }

  updateFish(t) {
    const { mesh, fish, uniforms } = this.school;
    const { a, b } = this.v;
    const d = this.dummy;
    this.fishBox.makeEmpty();
    for (const f of fish) {
      this.fishPosition(f, t, a);
      this.fishPosition(f, t + 0.05, b);
      d.position.copy(a);
      d.lookAt(b);
      d.scale.setScalar(f.scale);
      d.updateMatrix();
      mesh.setMatrixAt(f.i, d.matrix);
      this.fishBox.expandByPoint(a);
    }
    this.fishBox.expandByScalar(0.3);
    mesh.instanceMatrix.needsUpdate = true;
    uniforms.uTime.value = t;
  }

  updateTargets(t, overview, dark) {
    const cam = this.camera;
    const v = this.v.a;
    const centre = this.v.b;
    for (const tg of this.targets) {
      const d = tg.data;
      const since = t - d.detectAt;
      const detected = since >= 0 && dark < 0.98;

      const pulse = detected ? ease(0, 0.9, since) : 0;
      const ring = tg.ring.material.uniforms;
      ring.uRadius.value = tg.ring.userData.radius * (0.35 + 0.65 * pulse);
      ring.uOpacity.value = detected ? (1 - dark) * (0.3 + 0.9 * (1 - pulse) + 0.35 * overview) * (d.filtered ? 0.4 : 1) : 0;
      if (tg.beacon) {
        tg.beacon.material.uniforms.uTime.value = t;
        tg.beacon.material.uniforms.uOpacity.value = detected ? overview * 0.9 * (1 - dark) : 0;
      }

      if (!tg.el) continue;
      if (!detected) {
        if (tg.shown) {
          tg.el.style.opacity = '0';
          tg.shown = false;
        }
        continue;
      }

      // Project the bounding box to screen space.
      const box = tg.box;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let behind = false;
      for (let c = 0; c < 8; c++) {
        v.set(c & 1 ? box.max.x : box.min.x, c & 2 ? box.max.y : box.min.y, c & 4 ? box.max.z : box.min.z);
        v.applyMatrix4(cam.matrixWorldInverse);
        if (v.z > -0.5) {
          behind = true;
          break;
        }
        v.applyMatrix4(cam.projectionMatrix);
        const sx = (v.x * 0.5 + 0.5) * this.width;
        const sy = (0.5 - v.y * 0.5) * this.height;
        x0 = Math.min(x0, sx);
        x1 = Math.max(x1, sx);
        y0 = Math.min(y0, sy);
        y1 = Math.max(y1, sy);
      }
      if (behind) {
        tg.el.style.opacity = '0';
        tg.shown = false;
        continue;
      }

      const lock = clamp01(since / 0.45);
      const grow = 1 + 0.8 * (1 - lock) ** 2;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const hw = Math.max(10, ((x1 - x0) / 2) * grow + 5);
      const hh = Math.max(10, ((y1 - y0) / 2) * grow + 5);
      box.getCenter(centre);
      const distance = centre.distanceTo(cam.position);
      const reach = Math.max(1 - smoothstep(100, 150, distance), overview);
      const rejected = Boolean(d.filtered) && since > 1.5;
      // On wide screens the headline owns the left column: fade tags that drift underneath it.
      const clear = this.width >= 1024 ? smoothstep(0.36, 0.5, cx / this.width) : 1 - smoothstep(0.34, 0.44, cy / this.height);
      // Tags whose target leaves the frame fade out instead of piling up at the edges.
      const onScreen = smoothstep(70, 150, cy) * (1 - smoothstep(this.height - 60, this.height + 20, cy)) * smoothstep(-20, 60, cx) * (1 - smoothstep(this.width - 20, this.width + 40, cx));
      // Filtered targets are shown briefly, then only again on the map view.
      const filteredVis = d.filtered ? (rejected ? Math.max(0.62 * (1 - smoothstep(2.6, 3.4, since)), 0.62 * overview) : 1) : 1;
      const opacity = lock * reach * clear * onScreen * (1 - dark) * filteredVis;

      tg.el.style.opacity = opacity.toFixed(3);
      tg.el.style.transform = `translate3d(${(cx - hw).toFixed(1)}px, ${(cy - hh).toFixed(1)}px, 0)`;
      tg.el.style.width = `${(2 * hw).toFixed(1)}px`;
      tg.el.style.height = `${(2 * hh).toFixed(1)}px`;
      // Keep the label clear of the header and inside the viewport.
      const labelTop = cy - hh - 6 - (tg.geo || rejected ? 40 : 24);
      const labelLeft = cx - hw;
      const dy = Math.max(0, 84 - labelTop);
      const dx = Math.max(8 - labelLeft, Math.min(0, this.width - 8 - 270 - labelLeft));
      tg.el.style.setProperty('--label-dx', `${dx.toFixed(1)}px`);
      tg.el.style.setProperty('--label-dy', `${dy.toFixed(1)}px`);
      tg.shown = true;

      const conf = `${(d.confidence * ease(0, 0.9, since)).toFixed(1)}%`;
      if (conf !== tg.confText) {
        tg.confEl.textContent = conf;
        tg.confText = conf;
      }
      const geo = !d.filtered && t >= PHASES[3].start + 0.35 * tg.order;
      if (geo !== tg.geo) {
        tg.el.classList.toggle('is-geo', geo);
        tg.geo = geo;
      }
      if (rejected !== tg.rejected) {
        tg.el.classList.toggle('is-rejected', rejected);
        tg.rejected = rejected;
      }
    }
  }

  updateHud(t, zV, yV) {
    // Telemetry at ~6 Hz.
    if (Math.abs(t - this.lastTelemetry) > 0.16) {
      this.lastTelemetry = t;
      const { depth, altitude, position, pings } = this.telemetry;
      if (depth) depth.textContent = `${(SURVEY.waterDepth - yV).toFixed(1)} m`;
      if (altitude) altitude.textContent = `${(yV - this.terrainAt(0, zV)).toFixed(1)} m`;
      if (position) position.textContent = formatLatLon(toLatLon(0, zV));
      if (pings) {
        const n = Math.max(0, Math.floor((Math.min(zV, SURVEY.scanOffZ) - SURVEY.scanOnZ) / SONAR_STEP));
        pings.textContent = n.toString().padStart(4, '0');
      }
    }

    const ctx = this.wfCtx;
    if (!ctx) return;
    const W = this.wfW;
    const H = this.wfH;
    ctx.fillStyle = '#020609';
    ctx.fillRect(0, 0, W, H);
    const g = this.sonarGeo;
    const scanned = (Math.min(zV, SURVEY.scanOffZ) - SURVEY.scanOnZ) / SONAR_STEP;
    if (scanned <= 0) {
      ctx.fillStyle = 'rgba(148, 197, 214, 0.55)';
      ctx.font = '600 10px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('SONAR STANDBY', W / 2, H / 2 + 3);
      ctx.textAlign = 'start';
      return;
    }
    const top = g.nz - 1 - scanned; // image row of the newest ping
    const srcY = Math.max(0, top);
    const srcH = Math.min(g.nz - srcY, WATERFALL_ROWS - (srcY - top));
    if (srcH > 0) {
      ctx.drawImage(this.wfImage, 0, srcY, this.wfImage.width, srcH, 0, ((srcY - top) / WATERFALL_ROWS) * H, W, (srcH / WATERFALL_ROWS) * H);
    }
    // Newest ping line, track centre and range marks.
    ctx.fillStyle = 'rgba(103, 232, 249, 0.9)';
    ctx.fillRect(0, 0, W, 1.5);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    for (let k = 1; k < 4; k++) {
      const x = (k / 4) * W;
      ctx.fillRect(x, 0, 1, H);
    }

    ctx.font = '600 9px ui-monospace, Consolas, monospace';
    ctx.lineWidth = 1.4;
    for (let i = 0; i < TARGETS.length; i++) {
      const d = TARGETS[i];
      if (t < d.detectAt) continue;
      const b = this.wfBoxes[i];
      const y = ((b.row - top) / WATERFALL_ROWS) * H;
      const hh = Math.max(4, (b.halfRows / WATERFALL_ROWS) * H) + 2;
      if (y + hh < 0 || y - hh > H) continue;
      const bx0 = (b.x0 / (WATERFALL_HALF * 2)) * W - 3;
      const bx1 = (b.x1 / (WATERFALL_HALF * 2)) * W + 3;
      const tint = CLASS_TINT[d.cls];
      ctx.globalAlpha = d.filtered ? 0.7 : 1;
      ctx.setLineDash(d.filtered ? [3, 3] : []);
      ctx.strokeStyle = tint;
      ctx.strokeRect(bx0, y - hh, bx1 - bx0, 2 * hh);
      ctx.setLineDash([]);
      const text = d.filtered ? `${d.label} · filtered` : `${d.label} ${d.confidence}%`;
      const tw = ctx.measureText(text).width + 6;
      const lx = Math.min(Math.max(0, bx0), W - tw);
      const ly = y - hh - 12 < 0 ? y + hh : y - hh - 12;
      ctx.fillStyle = 'rgba(2, 10, 16, 0.85)';
      ctx.fillRect(lx, ly, tw, 12);
      ctx.fillStyle = tint;
      ctx.fillText(text, lx + 3, ly + 9);
      ctx.globalAlpha = 1;
    }
  }
}
