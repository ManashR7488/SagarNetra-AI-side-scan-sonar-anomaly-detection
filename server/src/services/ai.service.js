import { config } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

/** camelCase backend option -> snake_case AI form field */
const ANALYZE_FIELDS = {
  denoise: 'denoise', denoiseStrength: 'denoise_strength', clahe: 'clahe', claheStrength: 'clahe_strength',
  repairDropouts: 'repair_dropouts', shadowGamma: 'shadow_gamma', tiling: 'tiling', fpFilter: 'fp_filter',
  minScore: 'min_score',
};
const GEOREF_FIELDS = {
  latitude: 'latitude', longitude: 'longitude', headingDeg: 'heading_deg', swathWidthM: 'swath_width_m',
  acrossMPerPx: 'across_m_per_px', alongMPerPx: 'along_m_per_px', nadirColumn: 'nadir_column', anchor: 'anchor',
};

function appendFields(form, values, mapping) {
  for (const [key, field] of Object.entries(mapping)) {
    if (values?.[key] !== undefined && values[key] !== null) form.append(field, String(values[key]));
  }
}

const fileBlob = (file) => new Blob([file.buffer], { type: file.mimetype || 'application/octet-stream' });

/**
 * Attach an input either as bytes (multipart upload) or, for files already in cloud storage, as a URL the
 * AI service downloads itself. URLs keep large XTF logs clear of the 4.5 MB serverless request limit.
 * source: { buffer, originalname, mimetype } | { url, filename }
 */
function appendInput(form, source, field) {
  if (source.url) {
    form.append(`${field}_url`, source.url);
    form.append(field === 'file' ? 'filename' : `${field}_filename`, source.filename);
  } else {
    form.append(field, fileBlob(source), source.originalname);
  }
}

/** "data:image/jpeg;base64,..." -> Buffer */
export function dataUrlToBuffer(dataUrl) {
  const comma = typeof dataUrl === 'string' ? dataUrl.indexOf(',') : -1;
  return comma > 0 ? Buffer.from(dataUrl.slice(comma + 1), 'base64') : undefined;
}

async function call(path, { method = 'GET', body, timeoutMs = config.ai.timeoutMs, as = 'json' } = {}) {
  let res;
  try {
    const headers = config.ai.apiKey ? { 'X-API-Key': config.ai.apiKey } : undefined;
    res = await fetch(`${config.ai.url}${path}`, { method, body, headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new ApiError(504, `AI service did not respond within ${timeoutMs / 1000}s`);
    throw new ApiError(503, 'AI service unavailable', { details: { url: config.ai.url, cause: err.cause?.code ?? err.message } });
  }
  if (!res.ok) {
    let detail;
    try {
      detail = (await res.json()).detail;
    } catch {
      detail = await res.text().catch(() => undefined);
    }
    const message = typeof detail === 'string' ? detail : `AI service error (${res.status})`;
    // Input problems (bad file, unsupported type, validation) are the client's; anything else is a gateway failure.
    const status = [400, 404, 413, 415, 422].includes(res.status) ? res.status : 502;
    throw new ApiError(status, message, { code: 'AI_SERVICE_ERROR', details: typeof detail === 'string' ? undefined : detail });
  }
  if (as === 'buffer') return Buffer.from(await res.arrayBuffer());
  return res.json();
}

export const aiService = {
  health: () => call('/health', { timeoutMs: 5000 }),

  models: () => call('/v1/models', { timeoutMs: 10000 }),

  /**
   * Run the full AI pipeline. Result images come back inline (`images`, data URLs): a serverless AI service
   * cannot be asked for them in a second request, which may reach another instance.
   * @param source   { buffer, originalname, mimetype } or { url, filename }
   * @param metadata optional navigation CSV/JSON, same shapes
   */
  analyze(source, metadata, options = {}) {
    const form = new FormData();
    appendInput(form, source, 'file');
    if (metadata) appendInput(form, metadata, 'metadata');
    appendFields(form, options, ANALYZE_FIELDS);
    appendFields(form, options.georef, GEOREF_FIELDS);
    form.append('models', (options.models ?? ['detector', 'segmenter']).join(','));
    form.append('include_suppressed', 'true');
    form.append('return_images', 'true');
    return call('/v1/analyze', { method: 'POST', body: form });
  },

  /** Noise-filtration preview (not stored). output: 'json' | 'jpeg' */
  filter(source, options = {}, output = 'json') {
    const form = new FormData();
    appendInput(form, source, 'file');
    appendFields(form, options, ANALYZE_FIELDS);
    return call(`/v1/filter?output=${output}`, { method: 'POST', body: form, as: output === 'jpeg' ? 'buffer' : 'json' });
  },

  /** kind: 'annotated' | 'filtered' */
  image: (aiAnalysisId, kind) => call(`/v1/analyses/${aiAnalysisId}/${kind}.jpg`, { as: 'buffer', timeoutMs: 60000 }),
};
