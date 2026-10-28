/** Display metadata for the noise-filtering module (keep in sync with ai/app/cleaning and the server). */

export const STEP_META = {
  raw: { label: 'Raw input', short: 'Raw' },
  dropouts: { label: 'Dropouts & bad pings', short: 'Dropouts' },
  motion: { label: 'Motion compensation', short: 'Motion' },
  gain: { label: 'Gain & interference', short: 'Gain' },
  seabed: { label: 'Water column & ground range', short: 'Geometry' },
  speckle: { label: 'Speckle reduction', short: 'Speckle' },
  resolution: { label: 'Standard resolution', short: 'Resolution' },
  display: { label: 'Display enhancement', short: 'Display' },
};

export const PROFILE_META = {
  ai: {
    label: 'AI input',
    hint: 'The image the detector sees: only steps the measured noise needs and the benchmark proved help detection.',
  },
  analyst: {
    label: 'Analyst view',
    hint: 'The image a person reads: every needed step, ground-range geometry, smoother speckle, shadow emphasis.',
  },
};

export const DECISION_LABELS = {
  dropouts: 'Dropout repair',
  motion: 'Motion compensation',
  stripes: 'Interference removal',
  ping_gain: 'Ping gain',
  range_gain: 'Range gain',
  water_column: 'Water column',
  ground_range: 'Ground range',
  surface: 'Surface echo',
  speckle: 'Speckle filter',
  resolution: 'Resolution',
  display: 'Display',
};

/** Noise metrics: label, digits, and which direction is better. */
export const METRICS = [
  { key: 'enl', label: 'Equivalent looks (ENL)', digits: 1, better: 'up', hint: 'Higher = less speckle. Raw single-look sonar is ~1-10.' },
  { key: 'speckle_index', label: 'Speckle index', digits: 3, better: 'down', hint: 'Local std / mean. Lower = smoother.' },
  { key: 'across_imbalance', label: 'Across-track imbalance', digits: 2, better: 'down', hint: 'Brightest / darkest range band of the seabed. 1 = uniform.' },
  { key: 'port_stbd_ratio', label: 'Port / starboard', digits: 2, better: 'one', hint: 'Brightness of port vs starboard. 1 = balanced.' },
  { key: 'ping_jitter', label: 'Ping jitter', digits: 3, better: 'down', hint: 'Ping-to-ping brightness wobble (log). Lower = steadier.' },
  { key: 'gain_steps', label: 'Gain steps', digits: 0, better: 'down', hint: 'Electronic gain changes: the whole swath jumps at once.' },
  { key: 'stripe_fraction', label: 'Interference', digits: 3, better: 'down', pct: true, hint: 'Share of pixels on interference line bursts.' },
  { key: 'mean_intensity', label: 'Mean seabed level', digits: 1, better: null, hint: 'Average seabed brightness (0-255).' },
];

export const SUBSCORE_LABELS = {
  speckle: 'Speckle',
  gain_uniformity: 'Gain uniformity',
  ping_stability: 'Ping stability',
  interference: 'Interference',
  completeness: 'Data completeness',
  motion: 'Vehicle motion',
};

export const NATURAL_META = {
  rock: { label: 'Rock / rock cluster', short: 'Rock', color: '#a16207', badge: 'bg-amber-50 text-amber-800 border-amber-200' },
  sand_ripple: { label: 'Sand ripples / waves', short: 'Ripples', color: '#ca8a04', badge: 'bg-yellow-50 text-yellow-800 border-yellow-200' },
  natural_shadow: { label: 'Natural acoustic shadow', short: 'Shadow', color: '#475569', badge: 'bg-slate-100 text-slate-700 border-slate-300' },
  seabed_texture: { label: 'Seabed texture / speckle', short: 'Texture', color: '#64748b', badge: 'bg-slate-50 text-slate-600 border-slate-200' },
};

export const QUALITY_FLAG_LABELS = {
  time_gap: 'Time gap in the log',
  interference: 'Interference on these pings',
  in_water_column: 'In the water column',
  repaired_pings: 'Interpolated (repaired) pings',
  motion_flagged: 'Excessive vehicle motion',
  unrepaired_dropout: 'Lost pings',
};

export const DISTURBANCE_META = {
  speckle: { label: 'Speckle noise', hint: 'Multiplicative speckle, down to single-look' },
  dropouts: { label: 'Ping dropouts / motion', hint: 'Lost and partial pings, heave jitter, roll gain wobble' },
  resolution: { label: 'Lower resolution', hint: 'A coarser sonar: 1.5x to 6x fewer pixels' },
  gain: { label: 'Gain imbalance & stripes', hint: 'TVG error, gain drift and steps, interference bursts' },
};

export const PIPELINE_META = {
  raw: { label: 'No cleaning', short: 'raw', color: '#94a3b8' },
  auto: { label: 'Auto (AI profile)', short: 'auto', color: '#2563eb' },
  full: { label: 'Full visual cleaning', short: 'full', color: '#f59e0b' },
};

/** Reasons that depend on the score threshold (mirror of server SCORE_REASONS). */
const SCORE_REASONS = new Set(['below_min_score', 'rock_cluster', 'sand_ripple', 'natural_shadow', 'seabed_texture']);
const NATURAL_REASON = { rock: 'rock_cluster', sand_ripple: 'sand_ripple', natural_shadow: 'natural_shadow', seabed_texture: 'seabed_texture' };

/**
 * Live status of a candidate for a threshold and the operator's review, exactly as publishing will decide it
 * (server/src/services/scan.service.js decideStatus).
 */
export function liveStatus(d, threshold) {
  const aiReasons = (d.suppressionReasons ?? []).filter((r) => !SCORE_REASONS.has(r) && r !== 'operator_rejected');
  if (d.confidence < threshold) {
    aiReasons.push('below_min_score');
    const nat = NATURAL_REASON[d.natural?.label];
    if (nat) aiReasons.push(nat);
  }
  const aiStatus = aiReasons.length ? 'suppressed' : 'confirmed';
  const review = d.review?.status;
  if (review === 'verified') return { status: 'confirmed', reasons: [], aiStatus, override: 'confirmed' };
  if (review === 'false_positive') return { status: 'suppressed', reasons: [...aiReasons, 'operator_rejected'], aiStatus, override: 'rejected' };
  return { status: aiStatus, reasons: aiReasons, aiStatus, override: null };
}

export const fmtMetric = (m, v) => {
  if (v === undefined || v === null) return '—';
  if (m.pct) return `${(v * 100).toFixed(m.digits)}%`;
  return Number(v).toFixed(m.digits);
};

/** -1 worse, 0 same, 1 better */
export function metricTrend(m, before, after) {
  if (before === undefined || before === null || after === undefined || after === null || !m.better) return 0;
  const eps = Math.abs(before) * 0.01 + 1e-9;
  if (Math.abs(after - before) <= eps) return 0;
  if (m.better === 'up') return after > before ? 1 : -1;
  if (m.better === 'down') return after < before ? 1 : -1;
  return Math.abs(after - 1) < Math.abs(before - 1) ? 1 : -1;
}
