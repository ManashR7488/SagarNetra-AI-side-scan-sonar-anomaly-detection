import mongoose from 'mongoose';
import {
  CLASS_NAMES, DETECTION_STATUSES, REVIEW_STATUSES, SEVERITIES, SOURCE_MODELS, SUPPRESSION_REASONS,
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
    },

    // Operator workflow
    review: {
      status: { type: String, enum: REVIEW_STATUSES, default: 'unreviewed' },
      notes: { type: String, maxlength: 2000 },
      reviewedBy: { type: String, maxlength: 100 },
      reviewedAt: Date,
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

export const Detection = mongoose.model('Detection', detectionSchema);
