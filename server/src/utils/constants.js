// Must match the AI service model card / scoring module (ai/app/processing/scoring.py).
export const CLASS_NAMES = ['shipwreck', 'aircraft_wreck', 'mine_like_object', 'debris', 'human_body', 'marine_life'];
export const SEVERITIES = ['none', 'medium', 'high', 'critical'];
export const SEVERITY_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));
export const DETECTION_STATUSES = ['confirmed', 'suppressed'];
export const SOURCE_MODELS = ['detector', 'segmenter', 'detector+segmenter'];
export const SUPPRESSION_REASONS = [
  'natural_feature', 'low_contrast_speckle', 'sonar_data_dropout', 'too_small', 'below_min_score',
  // noise-filtering module: water column and the natural look-alikes named by the false-alarm classifier
  'water_column', 'rock_cluster', 'sand_ripple', 'natural_shadow', 'seabed_texture',
  'operator_rejected',                          // rejected by the operator during review
];
/** Reasons that depend on the score threshold (they change when the operator moves the threshold). */
export const SCORE_REASONS = ['below_min_score', 'rock_cluster', 'sand_ripple', 'natural_shadow', 'seabed_texture'];
export const NATURAL_REASON = { rock: 'rock_cluster', sand_ripple: 'sand_ripple', natural_shadow: 'natural_shadow', seabed_texture: 'seabed_texture' };
export const NATURAL_LABELS = ['rock', 'sand_ripple', 'natural_shadow', 'seabed_texture'];
export const FP_METHODS = ['auto', 'rules', 'classifier'];
export const CLEAN_PROFILES = ['ai', 'analyst'];
export const STRESS_DISTURBANCES = ['speckle', 'dropouts', 'resolution', 'gain'];

/** Drafts: scans analysed in the Noise Filtration tab and not (yet) sent to AI Detection. Removed after this long. */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

// Operator workflow after the AI has spoken.
export const REVIEW_STATUSES = ['unreviewed', 'verified', 'false_positive', 'cleanup_scheduled', 'cleared'];

export const SCAN_STATUSES = ['processing', 'completed', 'failed'];
export const MISSION_STATUSES = ['planned', 'active', 'completed', 'archived'];
export const PLATFORM_TYPES = ['ship', 'auv', 'usv', 'rov', 'other'];
export const DENOISE_METHODS = ['none', 'lee', 'frost', 'kuan', 'median'];

export const DEFAULT_MISSION_NAME = 'General Survey';
