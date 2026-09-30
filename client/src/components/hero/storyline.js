/**
 * The hero's story, shared by the three.js scene and the React overlay (this file does not import three).
 *
 * Times are seconds within one loop. Scene positions are metres: x east, z south, y up, seabed at y ≈ 0.
 * The AUV flies a straight survey line along x = 0 heading south (+z), so port is +x and starboard is -x.
 */
export const LOOP_S = 33;

export const SURVEY = {
  vehicle: 'AUV-01',
  mission: 'SN-0412',
  altitude: 8, // m above the seabed
  waterDepth: 50, // m at scene y = 0
  range: 30, // side-scan range per side, m
  frequencyKHz: 450,
  speed: 8, // scene m/s: a time-lapse of a ~2 m/s survey
  displaySpeedKn: 3.9,
  startZ: -150, // vehicle z at t = 0
  scanOnZ: -122, // sonar starts recording here...
  scanOffZ: 14, // ...and stops here
  headingDeg: 180,
  aiLatency: 0.7, // s between a target being fully imaged and the detection appearing
  origin: { lat: 13.0642, lon: 80.4175 }, // scene (0, 0): Bay of Bengal, off Chennai
};

export const vehicleZ = (t) => SURVEY.startZ + SURVEY.speed * t;
export const timeAtZ = (z) => (z - SURVEY.startZ) / SURVEY.speed;

const M_PER_DEG = 111320;
export function toLatLon(x, z) {
  const { lat, lon } = SURVEY.origin;
  return { lat: lat - z / M_PER_DEG, lon: lon + x / (M_PER_DEG * Math.cos((lat * Math.PI) / 180)) };
}
export const formatLatLon = ({ lat, lon }) => `${lat.toFixed(5)}° N  ${lon.toFixed(5)}° E`;

export const PHASES = [
  { id: 'survey', title: 'Survey', start: 0, text: 'An AUV flies a straight survey line, 8 m above the seabed.' },
  { id: 'sonar', title: 'Sonar', start: 3.5, text: 'Every ping paints one line of the side-scan image, 30 m out on each side.' },
  { id: 'detect', title: 'Detect', start: 7.4, text: 'SagarNetra flags wrecks, mine-like objects and ghost nets, and filters out rocks and fish.' },
  { id: 'geotag', title: 'Geotag', start: 21, text: 'Every target gets a latitude, longitude, size and a 0–100 % confidence.' },
  { id: 'report', title: 'Report', start: 26.5, text: 'JSON, CSV and GeoJSON reports go straight to the cleanup and survey teams.' },
];

export function phaseIndexAt(t) {
  let index = 0;
  for (let i = 0; i < PHASES.length; i++) if (t >= PHASES[i].start) index = i;
  return index;
}

/** Light tints of the app's class colours, readable on the dark ocean. */
export const CLASS_TINT = {
  shipwreck: '#60a5fa',
  aircraft_wreck: '#a78bfa',
  mine_like_object: '#f87171',
  debris: '#fbbf24',
  marine_life: '#34d399',
  natural: '#94a3b8',
};

/**
 * What lies along the survey line. `heading` is the long axis relative to the track (deg), `dims` is
 * [length, width] in metres, `reach` is how far the object extends along the track from its centre.
 */
const RAW_TARGETS = [
  { id: 'DET-001', kind: 'net', cls: 'debris', label: 'Ghost net', confidence: 88.4, x: -11, z: -98, reach: 4, heading: 30, dims: [7.8, 5.6] },
  { id: 'DET-002', kind: 'mine', cls: 'mine_like_object', label: 'Mine-like object', confidence: 91.6, x: 7, z: -80, reach: 1.5, heading: 62, dims: [2.6, 1.1] },
  { id: null, kind: 'rocks', cls: 'natural', label: 'Rock outcrop', confidence: 11.2, filtered: 'natural feature', x: -17, z: -64, reach: 4, heading: 10, dims: [7.4, 5.2] },
  { id: 'DET-003', kind: 'wreck', cls: 'shipwreck', label: 'Shipwreck', confidence: 97.8, x: -13, z: -43, reach: 9, heading: 28, dims: [21.4, 6.2] },
  { id: null, kind: 'fish', cls: 'marine_life', label: 'Fish school', confidence: 34.5, filtered: 'marine life', x: 4, z: -27, reach: 3, heading: 0, dims: [5.6, 4.2] },
  { id: 'DET-004', kind: 'aircraft', cls: 'aircraft_wreck', label: 'Aircraft wreck', confidence: 93.1, x: -9, z: -12, reach: 5.5, heading: 118, dims: [8.6, 11.0] },
  { id: 'DET-005', kind: 'pipe', cls: 'mine_like_object', label: 'Pipe section', confidence: 95.4, x: 8, z: 3, reach: 4, heading: 72, dims: [8.2, 0.9] },
];

export const TARGETS = RAW_TARGETS.map((t) => ({
  ...t,
  ...toLatLon(t.x, t.z),
  side: t.x >= 0 ? 'port' : 'starboard',
  acrossTrack: Math.abs(t.x),
  detectAt: timeAtZ(t.z + t.reach) + SURVEY.aiLatency,
}));

export const CONFIRMED = TARGETS.filter((t) => !t.filtered);
