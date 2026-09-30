import * as THREE from 'three';
import { DRAPE_PALETTE, RIPPLE } from './world';

const color = (hex) => new THREE.Color(hex);

// ---------------------------------------------------------------------------------------------- seabed

const SEABED_VERTEX = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormalW;
#include <fog_pars_vertex>
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const SEABED_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmb;
uniform vec3 uGroundAmb;
uniform vec3 uSandLight;
uniform vec3 uSandDark;
uniform sampler2D uDetail;
uniform vec4 uDetailRect;
uniform sampler2D uSonar;
uniform vec4 uSonarRect;
uniform vec4 uRipple;
uniform vec3 uPal[5];
uniform float uPalPos[5];
uniform float uScanZ;
uniform float uPaint;
uniform float uPing;
uniform float uPingOn;
uniform float uRange;
uniform vec3 uPool;
uniform float uGrid;
uniform float uCaustics;
varying vec3 vWorld;
varying vec3 vNormalW;
#include <fog_pars_fragment>

float hash12(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec2 hash22(vec2 p) {
  return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
}

// Distance to the nearest edge of an animated Voronoi pattern: caustic light gathers along the edges.
float cellEdge(vec2 x, float t) {
  vec2 n = floor(x);
  vec2 f = fract(x);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = 0.5 + 0.42 * sin(t + 6.2831 * hash22(n + g));
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return sqrt(d2) - sqrt(d1);
}

float caustics(vec2 p, float t) {
  float a = 1.0 - smoothstep(0.0, 0.45, cellEdge(p, t));
  float b = 1.0 - smoothstep(0.0, 0.45, cellEdge(p * 1.37 + 7.3, t * 0.83 + 2.0));
  return (a * a * a + b * b * b) * 0.5;
}

vec3 sonarRamp(float v) {
  vec3 c = uPal[0];
  for (int i = 1; i < 5; i++) {
    c = mix(c, uPal[i], clamp((v - uPalPos[i - 1]) / (uPalPos[i] - uPalPos[i - 1]), 0.0, 1.0));
  }
  return c;
}

void main() {
  vec2 p = vWorld.xz;
  vec4 det = texture2D(uDetail, (p - uDetailRect.xy) / uDetailRect.zw);

  // Sand ripples: the same wave the CPU sonar model uses, applied as a normal perturbation.
  float warp = 2.0 * sin(0.05 * p.x + 2.0 * sin(0.03 * p.y)) + 1.2 * sin(0.07 * p.y + 1.3);
  float phase = uRipple.y * (uRipple.z * p.x + uRipple.w * p.y) + warp;
  float mask = det.b;
  vec2 slope = uRipple.x * uRipple.y * cos(phase) * vec2(uRipple.z, uRipple.w) * mask;
  vec3 n = normalize(vNormalW + vec3(-slope.x, 0.0, -slope.y) * 1.6);

  vec3 albedo = mix(uSandDark, uSandLight, det.r);
  albedo *= 0.9 + 0.12 * valueNoise(p * 2.3) + 0.06 * valueNoise(p * 9.0);
  albedo *= 1.0 + 0.08 * sin(phase) * mask;

  float ao = det.g;
  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 ambient = mix(uGroundAmb, uSkyAmb, 0.5 + 0.5 * n.y);
  float c = caustics(p * 0.42, uTime * 0.6) * uCaustics;
  vec3 light = ambient * ao + uSunColor * ndl * (0.72 + 0.22 * c) * mix(1.0, ao, 0.7);
  vec2 dp = p - uPool.xz;
  light += vec3(1.0, 0.92, 0.78) * uPool.y * exp(-dot(dp, dp) / 22.0);
  vec3 col = albedo * light;

  // The side-scan image, draped wherever the sonar has already looked.
  vec2 suv = (p - uSonarRect.xy) / uSonarRect.zw;
  float across = abs(p.x);
  float inSwath = 1.0 - smoothstep(uRange - 0.6, uRange + 0.2, across);
  float covered = step(0.0, suv.y) * (1.0 - smoothstep(uScanZ - 0.5, uScanZ + 0.05, p.y));
  float paint = inSwath * covered * uPaint;
  // Scanned seabed: acoustic shadows darken it, strong echoes glow, like a sonar layer over the real floor.
  float echo = smoothstep(0.05, 0.8, texture2D(uSonar, suv).r);
  vec3 scanned = col * (0.28 + 0.8 * echo) + sonarRamp(echo) * (0.22 + 0.95 * echo * echo);
  col = mix(col, scanned, paint);
  // swath edges
  col += vec3(0.25, 0.8, 1.0) * exp(-pow((across - uRange) / 0.25, 2.0)) * covered * uPaint * 0.6;
  col += vec3(0.08, 0.45, 0.6) * exp(-max(uScanZ - p.y, 0.0) / 2.5) * paint * uPingOn * 0.35;

  // The current ping, sweeping outwards from under the vehicle.
  float along = uScanZ - p.y;
  float front = uPing * uRange;
  float band = exp(-pow((across - front) / 1.1, 2.0)) * exp(-along * along / 0.9);
  float line = exp(-along * along / 0.12) * (1.0 - smoothstep(front - 0.5, front + 0.5, across));
  col += vec3(0.3, 0.88, 1.0) * (band * 3.0 + line * 1.4) * inSwath * uPingOn;

  // Map graticule (20 m) and the dashed survey line for the overview shot.
  if (uGrid > 0.001) {
    vec2 cell = p / 20.0;
    vec2 d = abs(fract(cell + 0.5) - 0.5) / fwidth(cell);
    float gridLine = 1.0 - min(min(d.x, d.y), 1.0);
    float trackLine = (1.0 - min(abs(p.x) / (fwidth(p.x) * 1.5), 1.0)) * step(0.45, fract(p.y / 3.0)) * covered;
    col += vec3(0.35, 0.85, 1.0) * (gridLine * 0.4 + trackLine * 1.1) * uGrid;
  }

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export function createSeabedMaterial({ detail, sonar, lights }) {
  return new THREE.ShaderMaterial({
    vertexShader: SEABED_VERTEX,
    fragmentShader: SEABED_FRAGMENT,
    fog: true,
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: { value: 0 },
      uSunDir: { value: lights.sunDir.clone() },
      uSunColor: { value: lights.sunColor.clone() },
      uSkyAmb: { value: lights.skyAmbient.clone() },
      uGroundAmb: { value: lights.groundAmbient.clone() },
      uSandLight: { value: color('#8d8c7a') },
      uSandDark: { value: color('#595b52') },
      uDetail: { value: detail.texture },
      uDetailRect: { value: new THREE.Vector4(...detail.rect) },
      uSonar: { value: sonar.texture },
      uSonarRect: { value: new THREE.Vector4(...sonar.rect) },
      uRipple: { value: new THREE.Vector4(RIPPLE.amp, RIPPLE.k, RIPPLE.dirX, RIPPLE.dirZ) },
      uPal: { value: DRAPE_PALETTE.map(([, hex]) => color(hex)) },
      uPalPos: { value: DRAPE_PALETTE.map(([p]) => p) },
      uScanZ: { value: -1e4 },
      uPaint: { value: 1 },
      uPing: { value: 0 },
      uPingOn: { value: 0 },
      uRange: { value: 30 },
      uPool: { value: new THREE.Vector3() },
      uGrid: { value: 0 },
      uCaustics: { value: 1 },
    },
  });
}

// ---------------------------------------------------------------------------------------------- sonar fan

/** One side-scan beam: a thin fan perpendicular to the track, with a wavefront per ping. */
export function createFanMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uPhase: { value: 0 },
      uOn: { value: 0 },
      uSlant: { value: 32 },
      uAngles: { value: new THREE.Vector2(1.4, 0.26) },
      uColor: { value: color('#5ee7ff') },
    },
    vertexShader: /* glsl */ `
      varying vec2 vLocal;
      void main() {
        vLocal = vec2(abs(position.x), position.y);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uPhase;
      uniform float uOn;
      uniform float uSlant;
      uniform vec2 uAngles;
      uniform vec3 uColor;
      varying vec2 vLocal;
      void main() {
        float d = length(vLocal) / uSlant;
        float ang = atan(-vLocal.y, vLocal.x);
        float edge = smoothstep(uAngles.y, uAngles.y + 0.08, ang) * (1.0 - smoothstep(uAngles.x - 0.15, uAngles.x, ang));
        float wave = exp(-pow((d - uPhase) * 13.0, 2.0));
        float trail = smoothstep(uPhase - 0.45, uPhase, d) * step(d, uPhase) * 0.06;
        float body = 0.022 * (1.0 - 0.6 * d);
        float a = (wave * 0.5 + trail + body) * edge * uOn;
        gl_FragColor = vec4(uColor, a);
        #include <colorspace_fragment>
      }`,
  });
}

// ---------------------------------------------------------------------------------------------- marine snow

export function createSnowMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3(70, 34, 90) },
      uScale: { value: 600 },
      uFogDensity: { value: 0.02 },
      uOpacity: { value: 0.55 },
      uColor: { value: color('#cfeefa') },
    },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aSeed;
      uniform float uTime;
      uniform vec3 uCenter;
      uniform vec3 uBox;
      uniform float uScale;
      uniform float uFogDensity;
      varying float vFade;
      void main() {
        vec3 p = position;
        p.x += sin(uTime * 0.21 + aSeed * 40.0) * 0.6;
        p.z += cos(uTime * 0.17 + aSeed * 30.0) * 0.6;
        p.y -= uTime * (0.1 + 0.16 * aSeed);
        p = mod(p - uCenter + 0.5 * uBox, uBox) - 0.5 * uBox + uCenter;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float depth = -mv.z;
        gl_PointSize = clamp(aSize * uScale / depth, 0.0, 16.0);
        vFade = exp(-uFogDensity * uFogDensity * depth * depth) * smoothstep(0.8, 3.5, depth);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vFade;
      void main() {
        float a = (1.0 - smoothstep(0.08, 0.5, length(gl_PointCoord - 0.5))) * vFade * uOpacity;
        if (a < 0.004) discard;
        gl_FragColor = vec4(uColor, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// ---------------------------------------------------------------------------------------------- light shafts

export function createRayMaterial(seed) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uSeed: { value: seed },
      uOpacity: { value: 0.05 },
      uFogDensity: { value: 0.02 },
      uColor: { value: color('#8fdcff') },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying float vDepth;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uSeed;
      uniform float uOpacity;
      uniform float uFogDensity;
      uniform vec3 uColor;
      varying vec2 vUv;
      varying float vDepth;
      void main() {
        float shaft = pow(sin(3.14159 * vUv.x), 2.0);
        float flicker = 0.6 + 0.4 * sin(uTime * 0.55 + uSeed * 10.0 + vUv.y * 2.5);
        float vertical = smoothstep(0.0, 0.85, vUv.y);
        float fog = exp(-uFogDensity * uFogDensity * vDepth * vDepth * 0.3);
        gl_FragColor = vec4(uColor, shaft * flicker * vertical * uOpacity * fog);
        #include <colorspace_fragment>
      }`,
  });
}

// ---------------------------------------------------------------------------------------------- markers

/** A column of light rising from a geotagged target. */
export function createBeaconMaterial(tint) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 }, uColor: { value: color(tint) } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uOpacity;
      uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        float fade = pow(1.0 - vUv.y, 1.5);
        float pulse = 0.7 + 0.3 * sin(uTime * 3.0 - vUv.y * 9.0);
        gl_FragColor = vec4(uColor, fade * pulse * uOpacity);
        #include <colorspace_fragment>
      }`,
  });
}

/** A ring draped on the seabed around a detection; `uRadius` animates the lock-on pulse. */
export function createRingMaterial(tint) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    uniforms: { uRadius: { value: 1 }, uWidth: { value: 0.18 }, uOpacity: { value: 0 }, uColor: { value: color(tint) } },
    vertexShader: /* glsl */ `
      varying vec2 vLocal;
      void main() {
        vLocal = position.xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uRadius;
      uniform float uWidth;
      uniform float uOpacity;
      uniform vec3 uColor;
      varying vec2 vLocal;
      void main() {
        float r = length(vLocal);
        float ring = exp(-pow((r - uRadius) / uWidth, 2.0));
        float glow = exp(-pow((r - uRadius) / (uWidth * 6.0), 2.0)) * 0.25;
        gl_FragColor = vec4(uColor, (ring + glow) * uOpacity);
        #include <colorspace_fragment>
      }`,
  });
}

/** Sky-to-abyss gradient used to build the environment map for reflections. */
export function createEnvMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uTop: { value: color('#9fe6ff') }, uMid: { value: color('#1a6a8a') }, uBottom: { value: color('#03121b') } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop;
      uniform vec3 uMid;
      uniform vec3 uBottom;
      varying vec3 vDir;
      void main() {
        float h = vDir.y;
        vec3 c = h > 0.0 ? mix(uMid, uTop, pow(h, 0.7)) : mix(uMid, uBottom, pow(-h, 0.45));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}
