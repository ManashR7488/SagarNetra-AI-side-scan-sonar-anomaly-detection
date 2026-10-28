/** Display metadata for the detector's classes (keep in sync with the AI service). */
export const CLASS_META = {
  shipwreck: { label: 'Shipwreck', color: '#2563eb' },
  aircraft_wreck: { label: 'Aircraft Wreck', color: '#8b5cf6' },
  mine_like_object: { label: 'Pipe / Cylinder / Mine-like', color: '#dc2626' },
  debris: { label: 'Debris / Discarded Gear', color: '#d97706' },
  human_body: { label: 'Human Body (SAR)', color: '#db2777' },
  marine_life: { label: 'Marine Life (natural)', color: '#059669' },
};
export const CLASS_NAMES = Object.keys(CLASS_META);
export const classLabel = (name) => CLASS_META[name]?.label ?? name;
export const classColor = (name) => CLASS_META[name]?.color ?? '#64748b';

export const SEVERITY_META = {
  critical: { label: 'Critical', badge: 'bg-red-50 text-red-700 border-red-200' },
  high: { label: 'High', badge: 'bg-amber-50 text-amber-700 border-amber-200' },
  medium: { label: 'Medium', badge: 'bg-blue-50 text-blue-700 border-blue-200' },
  none: { label: 'None', badge: 'bg-slate-50 text-slate-600 border-slate-200' },
};

export const REVIEW_META = {
  unreviewed: { label: 'Unreviewed', badge: 'bg-slate-50 text-slate-600 border-slate-200' },
  verified: { label: 'Verified', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  false_positive: { label: 'False positive', badge: 'bg-slate-100 text-slate-500 border-slate-300 line-through' },
  cleanup_scheduled: { label: 'Cleanup scheduled', badge: 'bg-blue-50 text-blue-700 border-blue-200' },
  cleared: { label: 'Cleared', badge: 'bg-teal-50 text-teal-700 border-teal-200' },
};
export const REVIEW_STATUSES = Object.keys(REVIEW_META);

export const SUPPRESSION_LABELS = {
  natural_feature: 'Natural feature',
  low_contrast_speckle: 'Low contrast / speckle',
  sonar_data_dropout: 'Sonar data dropout',
  too_small: 'Too small',
  below_min_score: 'Below min score',
  water_column: 'In the water column',
  rock_cluster: 'Rock / rock cluster',
  sand_ripple: 'Sand ripples',
  natural_shadow: 'Natural acoustic shadow',
  seabed_texture: 'Seabed texture',
  operator_rejected: 'Rejected by operator',
};
