import mongoose from 'mongoose';
import { z } from 'zod';

export const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'must be a valid id');

export const idParams = z.object({ id: objectId });

/** Multipart/query values arrive as strings: "true"/"false"/"1"/"0"/"on". (z.coerce.boolean treats "false" as true.) */
export const bool = z.preprocess((v) => {
  if (v === undefined || v === '' || typeof v === 'boolean') return v === '' ? undefined : v;
  return ['true', '1', 'on', 'yes'].includes(String(v).toLowerCase());
}, z.boolean());

/** Optional number from a string field; empty string counts as "not provided". */
export const num = (schema = z.number()) => z.preprocess((v) => (v === '' || v === undefined ? undefined : Number(v)), schema);

/** "a,b,c" or repeated params -> string[] of allowed values */
export const csvEnum = (values) => z.preprocess(
  (v) => (v === undefined || v === '' ? undefined : (Array.isArray(v) ? v : String(v).split(',')).map((s) => s.trim()).filter(Boolean)),
  z.array(z.enum(values)).optional(),
);

/** "n1,n2,..." -> number[] with fixed length */
export const numberList = (length) => z.preprocess(
  (v) => (v === undefined || v === '' ? undefined : String(v).split(',').map(Number)),
  z.array(z.number().finite()).length(length).optional(),
);

export const pagination = {
  page: num(z.number().int().min(1).optional()),
  limit: num(z.number().int().min(1).max(5000).optional()),
};
