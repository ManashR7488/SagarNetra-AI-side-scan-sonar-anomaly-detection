import { config } from '../config/env.js';
import { dbState } from '../config/db.js';
import { storageService } from '../services/storage.service.js';
import { aiService } from '../services/ai.service.js';
import { ok } from '../utils/response.js';

let modelsCache = { at: 0, data: null };
const MODELS_TTL_MS = 60_000;

export async function health(_req, res) {
  const ai = await aiService.health().then(
    (h) => ({ status: h.status, modelsLoaded: h.models_loaded, device: h.device, backend: h.backend }),
    (err) => ({ status: 'unreachable', error: err.message }),
  );
  const database = dbState();
  const healthy = database === 'connected' && ai.status === 'ok';
  res.status(healthy ? 200 : 503).json({
    success: healthy,
    data: {
      status: healthy ? 'ok' : 'degraded',
      uptimeS: Math.round(process.uptime()),
      database,
      aiService: { url: config.ai.url, ...ai },
      storage: {
        provider: config.storage.provider,
        directUploads: storageService.directUploads,
        ...(config.storage.provider !== config.storage.requestedProvider && {
          note: 'Cloudinary credentials missing; using local disk',
        }),
      },
    },
  });
}

/** AI model cards (classes, thresholds, real test metrics) for the dashboard; cached for a minute. */
export async function models(_req, res) {
  if (!modelsCache.data || Date.now() - modelsCache.at > MODELS_TTL_MS) {
    modelsCache = { at: Date.now(), data: await aiService.models() };
  }
  ok(res, modelsCache.data);
}
