import { z } from 'zod';
import {
  CLEAN_PROFILES, DENOISE_METHODS, FP_METHODS, SCAN_STATUSES, STRESS_DISTURBANCES,
} from '../utils/constants.js';
import { bool, csvEnum, num, objectId, pagination } from './common.js';

/**
 * Noise-filtering stage-1 settings: a flat JSON object of booleans / numbers / short strings (the AI service
 * validates the exact keys). Arrives as a JSON string in multipart forms, as an object in JSON bodies.
 */
const cleaningSettings = z.preprocess((v) => {
  if (v === undefined || v === '' || v === null) return undefined;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return v; // fails the object check below with a clear message
    }
  }
  return v;
}, z.record(z.string().regex(/^[a-z_]{1,40}$/), z.union([z.boolean(), z.number().finite(), z.string().max(40)]))
  .refine((o) => Object.keys(o).length <= 40, 'too many cleaning settings')
  .optional());

/**
 * Analysis options accepted from the frontend (multipart fields for uploads, JSON for re-analysis).
 * Flat fields are grouped into { ...options, georef } for storage and for the AI service.
 */
const optionFields = {
  models: csvEnum(['detector', 'segmenter']),
  tiling: z.enum(['auto', 'on', 'off']).optional(),
  denoise: z.enum(DENOISE_METHODS).optional(),
  denoiseStrength: num(z.number().int().min(0).max(100).optional()),
  clahe: bool.optional(),
  claheStrength: num(z.number().int().min(0).max(100).optional()),
  repairDropouts: bool.optional(),
  shadowGamma: num(z.number().gt(0).max(4).optional()),
  fpFilter: bool.optional(),
  fpMethod: z.enum(FP_METHODS).optional(),
  minScore: num(z.number().min(0).max(100).optional()),
  cleaning: cleaningSettings,
  // simple georeference
  latitude: num(z.number().min(-90).max(90).optional()),
  longitude: num(z.number().min(-180).max(180).optional()),
  headingDeg: num(z.number().min(0).max(360).optional()),
  swathWidthM: num(z.number().positive().optional()),
  acrossMPerPx: num(z.number().positive().optional()),
  alongMPerPx: num(z.number().positive().optional()),
  nadirColumn: num(z.number().min(0).optional()),
  anchor: z.enum(['center', 'start']).optional(),
};

const GEOREF_KEYS = ['latitude', 'longitude', 'headingDeg', 'swathWidthM', 'acrossMPerPx', 'alongMPerPx', 'nadirColumn', 'anchor'];

const drop = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

function toOptions(v) {
  const georef = drop(Object.fromEntries(GEOREF_KEYS.map((k) => [k, v[k]])));
  const rest = drop(Object.fromEntries(Object.entries(v).filter(([k]) => !GEOREF_KEYS.includes(k) && !['missionId', 'name', 'draft'].includes(k))));
  return { ...rest, georef };
}

const latLonTogether = (v) => (v.latitude === undefined) === (v.longitude === undefined);
const LATLON_MSG = { message: 'latitude and longitude must be given together', path: ['latitude'] };

export const createScanBody = z.object({
  missionId: objectId.optional(),
  name: z.string().trim().max(200).optional(),
  draft: bool.optional(),                // Noise Filtration review: hidden until published
  ...optionFields,
}).refine(latLonTogether, LATLON_MSG)
  .transform((v) => ({ missionId: v.missionId, name: v.name, draft: v.draft ?? false, options: toOptions(v) }));

/** POST /api/scans/:id/publish: send a reviewed draft to AI Detection with the threshold chosen in the review. */
export const publishBody = z.object({
  minScore: num(z.number().min(0).max(100).optional()),
  name: z.string().trim().max(200).optional(),
}).strict();

/** Noise-filtering stage 1 preview (POST /api/filter/clean, multipart). */
export const cleanPreviewBody = z.object({
  profile: z.enum(CLEAN_PROFILES).optional(),
  auto: bool.optional(),
  params: cleaningSettings,
  swathWidthM: num(z.number().positive().optional()),
  acrossMPerPx: num(z.number().positive().optional()),
  previewSide: num(z.number().int().min(256).max(4096).optional()),
}).transform(drop);

export const cleanPreviewQuery = z.object({
  output: z.enum(['json', 'jpeg']).default('json'),
  step: z.enum(['raw', 'dropouts', 'motion', 'gain', 'seabed', 'speckle', 'resolution', 'display']).optional(),
});

/** Noise-filtering stage 3 (POST /api/filter/stress, multipart). */
export const stressBody = z.object({
  disturbance: z.enum(STRESS_DISTURBANCES),
  levels: num(z.number().int().min(1).max(5).optional()),
  roi: z.string().regex(/^\d+(\.\d+)?(,\d+(\.\d+)?){3}$/, 'roi must be x,y,width,height').optional(),
  maxSide: num(z.number().int().min(256).max(4096).optional()),
}).transform(drop);

export const reanalyzeBody = z.object(optionFields).partial()
  .refine(latLonTogether, LATLON_MSG)
  .transform((v) => {
    const o = toOptions(v);
    if (!Object.keys(o.georef).length) delete o.georef; // keep the scan's previous georeference
    return o;
  });

export const filterPreviewBody = z.object({
  denoise: z.enum(DENOISE_METHODS).optional(),
  denoiseStrength: optionFields.denoiseStrength,
  clahe: optionFields.clahe,
  claheStrength: optionFields.claheStrength,
  repairDropouts: optionFields.repairDropouts,
  shadowGamma: optionFields.shadowGamma,
}).transform(drop);

export const filterPreviewQuery = z.object({ output: z.enum(['json', 'jpeg']).default('json') });

export const listScansQuery = z.object({
  ...pagination,
  missionId: objectId.optional(),
  status: z.enum(SCAN_STATUSES).optional(),
  includeDrafts: bool.optional(),
});

export const getScanQuery = z.object({ includeSuppressed: bool.default(true) });
