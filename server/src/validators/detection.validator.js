import { z } from 'zod';
import { CLASS_NAMES, DETECTION_STATUSES, REVIEW_STATUSES, SEVERITIES } from '../utils/constants.js';
import { bool, csvEnum, num, numberList, objectId, pagination } from './common.js';

export const detectionQuery = z.object({
  ...pagination,
  missionId: objectId.optional(),
  scanId: objectId.optional(),
  className: csvEnum(CLASS_NAMES),
  severity: csvEnum(SEVERITIES),
  status: z.enum(DETECTION_STATUSES).optional(),
  reviewStatus: csvEnum(REVIEW_STATUSES),
  hazardOnly: bool.optional(),
  hasLocation: bool.optional(),
  minConfidence: num(z.number().min(0).max(100).optional()),
  maxConfidence: num(z.number().min(0).max(100).optional()),
  bbox: numberList(4),                 // minLon,minLat,maxLon,maxLat
  near: numberList(2),                 // lon,lat
  radiusM: num(z.number().positive().max(1_000_000).optional()),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sortBy: z.enum(['confidence', 'createdAt', 'className', 'code']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
}).refine((v) => !(v.bbox && v.near), { message: 'use either bbox or near, not both', path: ['bbox'] });

export const reviewBody = z.object({
  status: z.enum(REVIEW_STATUSES),
  notes: z.string().trim().max(2000).optional(),
  reviewedBy: z.string().trim().max(100).optional(),
}).strict();
