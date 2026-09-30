import mongoose from 'mongoose';
import { MISSION_STATUSES, PLATFORM_TYPES, SEVERITIES } from '../utils/constants.js';
import { toJSONOptions } from './shared.js';

const { Schema } = mongoose;

/** A survey campaign (e.g. "Chennai coast ghost-net survey, Oct 2026") grouping many scans. */
const missionSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120, unique: true },
    description: { type: String, trim: true, maxlength: 2000 },
    region: { type: String, trim: true, maxlength: 120 },
    status: { type: String, enum: MISSION_STATUSES, default: 'active', index: true },
    platform: {
      name: { type: String, trim: true },               // vessel / AUV name
      type: { type: String, enum: PLATFORM_TYPES, default: 'ship' },
    },
    sonar: {
      model: { type: String, trim: true },
      frequencyKhz: { type: Number, min: 0 },
    },
    // Defaults applied to scans of this mission when the upload has no navigation data.
    defaults: {
      swathWidthM: { type: Number, min: 0 },
      headingDeg: { type: Number, min: 0, max: 360 },
    },
    startDate: Date,
    endDate: Date,
    isDefault: { type: Boolean, default: false },       // the auto-created "General Survey" mission

    // Denormalised counters, refreshed after every scan is added or removed (see mission.service.js).
    stats: {
      scans: { type: Number, default: 0 },
      detections: { type: Number, default: 0 },
      confirmed: { type: Number, default: 0 },
      hazards: { type: Number, default: 0 },
      maxSeverity: { type: String, enum: SEVERITIES, default: 'none' },
      lastScanAt: Date,
    },
  },
  { timestamps: true, toJSON: toJSONOptions(), toObject: { virtuals: true } },
);

missionSchema.index({ createdAt: -1 });

export const Mission = mongoose.model('Mission', missionSchema);
