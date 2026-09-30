import { z } from 'zod';
import { MISSION_STATUSES, PLATFORM_TYPES } from '../utils/constants.js';
import { pagination } from './common.js';

const base = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  region: z.string().trim().max(120).optional(),
  status: z.enum(MISSION_STATUSES).optional(),
  platform: z.object({ name: z.string().trim().max(120).optional(), type: z.enum(PLATFORM_TYPES).optional() }).optional(),
  sonar: z.object({ model: z.string().trim().max(120).optional(), frequencyKhz: z.number().positive().optional() }).optional(),
  defaults: z.object({
    swathWidthM: z.number().positive().optional(),
    headingDeg: z.number().min(0).max(360).optional(),
  }).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
};

export const createMissionBody = z.object(base).strict();
export const updateMissionBody = z.object(base).partial().strict()
  .refine((v) => Object.keys(v).length > 0, 'provide at least one field to update');

export const listMissionsQuery = z.object({
  ...pagination,
  status: z.enum(MISSION_STATUSES).optional(),
  search: z.string().trim().max(120).optional(),
});
