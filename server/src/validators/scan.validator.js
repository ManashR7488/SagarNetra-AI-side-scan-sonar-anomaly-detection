import { z } from 'zod';
import { DENOISE_METHODS, SCAN_STATUSES } from '../utils/constants.js';
import { bool, csvEnum, num, objectId, pagination } from './common.js';

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
  minScore: num(z.number().min(0).max(100).optional()),
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
  const rest = drop(Object.fromEntries(Object.entries(v).filter(([k]) => !GEOREF_KEYS.includes(k) && !['missionId', 'name'].includes(k))));
  return { ...rest, georef };
}

const latLonTogether = (v) => (v.latitude === undefined) === (v.longitude === undefined);
const LATLON_MSG = { message: 'latitude and longitude must be given together', path: ['latitude'] };

export const createScanBody = z.object({
  missionId: objectId.optional(),
  name: z.string().trim().max(200).optional(),
  ...optionFields,
}).refine(latLonTogether, LATLON_MSG)
  .transform((v) => ({ missionId: v.missionId, name: v.name, options: toOptions(v) }));

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
});

export const getScanQuery = z.object({ includeSuppressed: bool.default(true) });
