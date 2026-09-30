import compression from 'compression';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { ensureDB } from './config/db.js';
import { config } from './config/env.js';
import { errorHandler, notFound } from './middlewares/errorHandler.js';
import { apiLimiter } from './middlewares/rateLimiter.js';
import apiRoutes from './routes/index.js';
import { ApiError } from './utils/ApiError.js';

/** `lazyDb`: connect to MongoDB on the first request (serverless) instead of before listening. */
export function createApp({ lazyDb = false } = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // Result images are loaded by the React app from another origin.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: config.cors.origins, exposedHeaders: ['Content-Disposition'] }));
  app.use(compression());
  if (!config.isTest) app.use(morgan(config.env === 'production' ? 'combined' : 'dev'));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  if (config.storage.provider === 'local') {
    app.use('/uploads', express.static(config.storage.localDir, { maxAge: '7d', fallthrough: false }));
  }

  app.get('/', (_req, res) => res.json({ service: 'SonarScan API', health: '/api/health' }));
  if (lazyDb) {
    app.use('/api', (_req, _res, next) => {
      ensureDB().then(() => next(), (err) => next(new ApiError(503, 'Database unavailable', { details: { cause: err.message } })));
    });
  }
  app.use('/api', apiLimiter, apiRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

// Vercel's zero-config Express runtime serves the default export as one function (see vercel.json).
export default createApp({ lazyDb: true });
