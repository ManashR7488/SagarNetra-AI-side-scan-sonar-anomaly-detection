import mongoose from 'mongoose';
import { DENOISE_METHODS, SCAN_STATUSES, SEVERITIES } from '../utils/constants.js';
import { lineStringSchema, pointSchema, storedFileSchema, toJSONOptions } from './shared.js';

const { Schema } = mongoose;

/** One uploaded sonar file (image or XTF log) and the result of analysing it. */
const scanSchema = new Schema(
  {
    mission: { type: Schema.Types.ObjectId, ref: 'Mission', required: true, index: true },
    name: { type: String, trim: true, maxlength: 200 },
    status: { type: String, enum: SCAN_STATUSES, default: 'processing', index: true },
    error: { message: String, code: String, status: Number },
    warnings: [String],

    source: {
      filename: { type: String, required: true },
      format: String,                                  // png | jpg | tif | xtf ...
      mimeType: String,
      sizeBytes: Number,
      width: Number,                                   // analysed image size (XTF: resampled waterfall)
      height: Number,
      file: storedFileSchema,                          // the original upload
      metadataFile: { filename: String, file: storedFileSchema },
      sonar: {                                         // from XTF headers when available
        name: String,
        pings: Number,
        frequencyKhz: Number,
        slantRangeM: Number,
      },
    },

    // Analysis options as sent to the AI service (kept so a scan can be re-analysed identically).
    options: {
      models: { type: [String], default: ['detector', 'segmenter'] },
      tiling: { type: String, enum: ['auto', 'on', 'off'], default: 'auto' },
      denoise: { type: String, enum: DENOISE_METHODS, default: 'none' },
      denoiseStrength: Number,
      clahe: Boolean,
      claheStrength: Number,
      repairDropouts: Boolean,
      shadowGamma: Number,
      fpFilter: Boolean,
      minScore: Number,
      georef: {                                        // simple georeference supplied by the operator
        latitude: Number,
        longitude: Number,
        headingDeg: Number,
        swathWidthM: Number,
        acrossMPerPx: Number,
        alongMPerPx: Number,
        nadirColumn: Number,
        anchor: { type: String, enum: ['center', 'start'] },
      },
    },

    georeference: {
      available: { type: Boolean, default: false },
      reason: String,                                  // why not, when unavailable
      source: String,                                  // xtf_ping_headers | navigation_csv | navigation_json | simple
      start: pointSchema,
      end: pointSchema,
      track: lineStringSchema,                         // vehicle track for the map
      trackLengthM: Number,
      meanHeadingDeg: Number,
      acrossTrackMPerPx: Number,
      alongTrackMPerPx: Number,
      nadirColumn: Number,
      slantRangeCorrected: Boolean,
      startTime: Date,
      endTime: Date,
      assumptions: [String],
    },

    summary: {
      candidates: { type: Number, default: 0 },
      confirmed: { type: Number, default: 0 },
      suppressed: { type: Number, default: 0 },
      hazards: { type: Number, default: 0 },
      byClass: { type: Map, of: Number, default: {} },
      suppressedByReason: { type: Map, of: Number, default: {} },
      maxSeverity: { type: String, enum: SEVERITIES, default: 'none' },
      meanConfidence: Number,
    },

    processing: {
      aiAnalysisId: String,
      models: Schema.Types.Mixed,                      // { detector: { name, weights, device }, ... }
      tiled: Boolean,
      tiles: Number,
      timings: Schema.Types.Mixed,                     // AI-side timings (ms)
      filters: Schema.Types.Mixed,                     // filter params + speckle metrics before/after
      startedAt: Date,
      completedAt: Date,
      durationMs: Number,                              // end-to-end, including uploads
    },

    images: {
      annotated: storedFileSchema,
      filtered: storedFileSchema,
    },
  },
  { timestamps: true, toJSON: toJSONOptions(), toObject: { virtuals: true } },
);

scanSchema.index({ mission: 1, createdAt: -1 });
scanSchema.index({ 'georeference.start': '2dsphere' });

export const Scan = mongoose.model('Scan', scanSchema);
