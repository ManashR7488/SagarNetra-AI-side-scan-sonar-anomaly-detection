import rateLimit from 'express-rate-limit';
import { config } from '../config/env.js';

const handler = (_req, res) => res.status(429).json({
  success: false,
  error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down' },
});

export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.rateLimitPerMinute,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => config.isTest,
  handler,
});

/** Analyses are expensive (GPU/CPU inference + uploads): stricter limit. */
export const analysisLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => config.isTest,
  handler,
});
