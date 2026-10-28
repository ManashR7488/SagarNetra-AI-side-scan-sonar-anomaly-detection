import mongoose from 'mongoose';
import {
  CLASS_NAMES, DETECTION_STATUSES, NATURAL_LABELS, REVIEW_STATUSES, SEVERITIES, SOURCE_MODELS, SUPPRESSION_REASONS,
} from '../utils/constants.js';
import { pointSchema, toJSONOptions } from './shared.js';

const { Schema } = mongoose;

/**
 * One detected anomaly. Kept in its own collection (not embedded in Scan) so detections can be
 * queried across scans and missions: map views (2dsphere), dashboards (aggregations), review queues.
 */
const detectionSchema = new Schema(
  {
    scan: { type: Schema.Types.ObjectId, ref: 'Scan', required: true, index: true },
    mission: { type: Schema.Types.ObjectId, ref: 'Mission', required: true, index: true }, // denormalised
    code: { type: String, required: true },            // "DET-001" within its scan
    draft: { type: Boolean, default: false },          // scan still under review in the Noise Filtration tab

    // Classification
    className: { type: String, enum: CLASS_NAMES, required: true },
    category: { type: String, required: true },         // human-readable, e.g. "Pipe / Cylinder / Mine-like Object"
    severity: { type: String, enum: SEVERITIES, required: true },
    isHazard: { type: Boolean, required: true },
    sourceModel: { type: String, enum: SOURCE_MODELS },

    // Confidence scoring & false-positive filter
    confidence: { type: Number, min: 0, max: 100, required: true },   // final 0-100 score
    status: { type: String, enum: DETECTION_STATUSES, required: true },
    suppressionReasons: [{ type: String, enum: SUPPRESSION_REASONS }],
    evidence: {
      modelConfidence: Number,                          // raw model probability 0-1
      calibratedThreshold: Number,
      shadow: Number,
      linearity: Number,
      contrast: Number,
      acousticEvidence: Number,
      modelAgreement: Boolean,
      isolation: Number,                                // stands apart from the surrounding seabed texture
      periodicity: Number,                              // periodic pattern around it (sand ripples)
      orientationCoherence: Number,                     // uniformly oriented texture (bedforms)
      blobDensity: Number,                              // similar bright blobs nearby (rock cluster)
    },

    // False-alarm classifier: man-made or natural, and why
    natural: {
      method: { type: String, enum: ['classifier', 'rules'] },
      pManMade: Number,                                 // 0-1 (classifier)
      label: { type: String, enum: NATURAL_LABELS },    // set when judged natural
      subtypeProbabilities: Schema.Types.Mixed,
      reasons: [String],                                // plain-language evidence
    },
    // Acoustic shadow attached to the candidate (image pixels)
    shadow: {
      found: Boolean,
      polygon: { type: [[Number]], default: undefined },
      lengthPx: Number,
      lengthRatio: Number,                              // shadow length / object width
      areaRatio: Number,
      solidity: Number,
      sharpness: Number,
      darkness: Number,
      pieces: Number,                                   // separate dark patches nearby
    },
    // Data quality at the detection (noise-filtering stage 1)
    quality: {
      repairedPings: Number,                            // share of its pings that were interpolated
      timeGap: Boolean,
      motionFlagged: Number,                            // share of its pings beyond motion limits
      interference: Boolean,
      unrepairedDropout: Number,
      inWaterColumn: Boolean,
      nearNadir: Boolean,
      resolutionM: Number,
      flags: [String],
      score: Number,                                    // 0-100
    },

    // Image-space geometry (pixels of the analysed image)
    bbox: {
      x1: Number, y1: Number, x2: Number, y2: Number, width: Number, height: Number,
    },
    bboxPct: { x: Number, y: Number, width: Number, height: Number },   // 0-100, for UI overlays
    centroidPx: { x: Number, y: Number },
    polygons: { type: [[[Number]]], default: undefined },               // segmentation outlines [[[x, y], ...]]

    // Geotag
    location: { type: pointSchema, default: undefined },                // GeoJSON [lon, lat]
    geo: {
      side: { type: String, enum: ['port', 'starboard'] },
      acrossTrackM: Number,                              // distance from the vehicle track
      vehicleLocation: { type: pointSchema, default: undefined },
      vehicleHeadingDeg: Number,
      altitudeM: Number,
      timestamp: Date,                                   // ping time (XTF)
    },
    dimensions: {
      acrossTrackM: Number,
      alongTrackM: Number,
      areaM2: Number,
      areaFrom: { type: String, enum: ['mask', 'bbox'] },
      heightM: Number,                                 // from the acoustic shadow length
      heightMethod: String,
      shadowLengthM: Number,
      leastDepthM: Number,                             // shallowest depth over the target (measured depth only)
    },

    // Operator workflow
    review: {
      status: { type: String, enum: REVIEW_STATUSES, default: 'unreviewed' },
      notes: { type: String, maxlength: 2000 },
      reviewedBy: { type: String, maxlength: 100 },
      reviewedAt: Date,
      origin: { type: String, enum: ['ai_detection', 'noise_filtration'] },   // where the operator decided
      aiStatus: { type: String, enum: DETECTION_STATUSES },                   // the AI's own decision, kept
    },
  },
  { timestamps: true, toJSON: toJSONOptions(), toObject: { virtuals: true } },
);

detectionSchema.index({ scan: 1, code: 1 }, { unique: true });
detectionSchema.index({ location: '2dsphere' });                         // near / within-box map queries
detectionSchema.index({ mission: 1, status: 1, severity: 1 });
detectionSchema.index({ className: 1, confidence: -1 });
detectionSchema.index({ 'review.status': 1 });
detectionSchema.index({ createdAt: -1 });
detectionSchema.index({ draft: 1, mission: 1 });

export const Detection = mongoose.model('Detection', detectionSchema);
