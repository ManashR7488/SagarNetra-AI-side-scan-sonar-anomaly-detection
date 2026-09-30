import mongoose from 'mongoose';
import multer from 'multer';
import { config } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';

export const notFound = (req, _res, next) => next(new ApiError(404, `Route ${req.method} ${req.originalUrl} not found`));

/** Translate known errors into ApiError; everything else is a 500 (details hidden in production). */
function normalise(err) {
  if (err instanceof ApiError) return err;
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return new ApiError(413, `File larger than ${Math.round(config.upload.maxBytes / 1024 / 1024)} MB`);
    }
    return ApiError.badRequest(`Upload error: ${err.message}`);
  }
  if (err instanceof mongoose.Error.ValidationError) {
    return ApiError.badRequest('Validation failed', Object.values(err.errors).map((e) => ({ field: e.path, message: e.message })));
  }
  if (err instanceof mongoose.Error.CastError) return ApiError.badRequest(`Invalid ${err.path}: ${err.value}`);
  if (err?.code === 11000) {
    return new ApiError(409, `Duplicate value for ${Object.keys(err.keyValue ?? {}).join(', ') || 'unique field'}`);
  }
  if (err?.type === 'entity.parse.failed') return ApiError.badRequest('Malformed JSON body');
  if (err?.type === 'entity.too.large') return new ApiError(413, 'Request body too large');
  // http-errors from Express internals (e.g. express.static 404)
  if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) return new ApiError(err.status, err.message);
  return null;
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const known = normalise(err);
  const error = known ?? new ApiError(500, config.env === 'production' ? 'Internal server error' : err.message);
  if (!known || error.status >= 500) logger.error(`${req.method} ${req.originalUrl} -> ${error.status}`, known ? error.message : err);
  res.status(error.status).json({
    success: false,
    error: { code: error.code, message: error.message, ...(error.details !== undefined && { details: error.details }) },
  });
}
