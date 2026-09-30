// Must match the AI service model card / scoring module (ai/app/processing/scoring.py).
export const CLASS_NAMES = ['shipwreck', 'aircraft_wreck', 'mine_like_object', 'debris', 'human_body', 'marine_life'];
export const SEVERITIES = ['none', 'medium', 'high', 'critical'];
export const SEVERITY_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));
export const DETECTION_STATUSES = ['confirmed', 'suppressed'];
export const SOURCE_MODELS = ['detector', 'segmenter', 'detector+segmenter'];
export const SUPPRESSION_REASONS = ['natural_feature', 'low_contrast_speckle', 'sonar_data_dropout', 'too_small', 'below_min_score'];

// Operator workflow after the AI has spoken.
export const REVIEW_STATUSES = ['unreviewed', 'verified', 'false_positive', 'cleanup_scheduled', 'cleared'];

export const SCAN_STATUSES = ['processing', 'completed', 'failed'];
export const MISSION_STATUSES = ['planned', 'active', 'completed', 'archived'];
export const PLATFORM_TYPES = ['ship', 'auv', 'usv', 'rov', 'other'];
export const DENOISE_METHODS = ['none', 'lee', 'frost', 'kuan', 'median'];

export const DEFAULT_MISSION_NAME = 'General Survey';
