import mongoose from 'mongoose';
import { DENOISE_METHODS, FP_METHODS, SCAN_STATUSES, SEVERITIES } from '../utils/constants.js';
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
    // Noise Filtration tab: analysed for review, not yet sent to AI Detection (hidden from lists, map and stats)
    draft: { type: Boolean, default: false, index: true },
    review: {
      origin: { type: String, enum: ['noise_filtration'] },
      minScore: Number,                                // threshold chosen while reviewing
      publishedAt: Date,
    },

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
      fpMethod: { type: String, enum: FP_METHODS },
      minScore: Number,
      cleaning: Schema.Types.Mixed,                    // noise-filtering stage-1 settings (see ai/app/cleaning)
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
      cleaning: Schema.Types.Mixed,                    // stage-1 cleaning: settings, frame, noise report
      falseAlarmFilter: Schema.Types.Mixed,            // rules | classifier (+ version and cross-validated metrics)
      startedAt: Date,
      completedAt: Date,
      durationMs: Number,                              // end-to-end, including uploads
    },

    images: {
      annotated: storedFileSchema,
      filtered: storedFileSchema,
    },

    // 3D seabed model of the survey strip (heightfield + ground-range sonar texture), see ai/app/seabed.
    seabed: {
      available: { type: Boolean, default: false },
      reason: String,
      kind: { type: String, enum: ['measured', 'relative'] },  // measured = absolute depths from navigation
      grid: {                                          // rows = along-track s, columns = ground range u (port < 0)
        nx: Number,
        nz: Number,
        cellXM: Number,
        cellZM: Number,
        widthM: Number,
        lengthM: Number,
      },
      elevation: {                                     // uint16 little-endian; metres = value * scale + offset
        file: storedFileSchema,
        scale: Number,
        offset: Number,
        minM: Number,
        maxM: Number,
      },
      texture: storedFileSchema,
      depth: { minM: Number, maxM: Number },
      relief: { rmsM: Number, maxAbsM: Number },
      altitude: { minM: Number, maxM: Number, assumed: Boolean, source: String, checkM: Number },
      slantRangeCorrected: Boolean,
      geometry: Schema.Types.Mixed,                    // { sources, nadirColumn, swathM, bottomTrack }
      coverage: { coveredFraction: Number, dropoutFraction: Number, outsideSwathFraction: Number, nadirZoneM: Number },
      track: Schema.Types.Mixed,                       // { s, lat, lon, heading, altitude, depth } samples
      targets: Schema.Types.Mixed,                     // [{ detectionCode, className, status, s, u, heightM, leastDepthM, ... }]
      methods: Schema.Types.Mixed,
      assumptions: [String],
    },
  },
  { timestamps: true, toJSON: toJSONOptions(), toObject: { virtuals: true } },
);

scanSchema.index({ mission: 1, createdAt: -1 });
scanSchema.index({ 'georeference.start': '2dsphere' });

export const Scan = mongoose.model('Scan', scanSchema);
