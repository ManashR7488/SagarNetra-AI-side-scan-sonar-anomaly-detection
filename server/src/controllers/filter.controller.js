import { aiService } from '../services/ai.service.js';
import { storageService } from '../services/storage.service.js';
import { ok } from '../utils/response.js';

/** Run `fn(source)` on the uploaded sonar file (or a direct Cloudinary upload, deleted afterwards). */
async function withSource(req, fn) {
  const stored = req.sonarRef ? await storageService.resolveDirectUpload(req.sonarRef) : undefined;
  try {
    return await fn(stored ? { url: stored.url, filename: req.sonarRef.filename } : req.file);
  } finally {
    if (stored) await storageService.remove(stored);
  }
}

/** Noise-filtering stage 1: step-by-step cleaning previews and the noise report. Nothing is stored. */
export async function cleanPreview(req, res) {
  const { output, step } = req.valid.query;
  const result = await withSource(req, (source) => aiService.clean(source, req.valid.body, { output, step }));
  if (output === 'jpeg') return res.type('image/jpeg').send(result);
  ok(res, result);
}

/** Noise-filtering stage 3: robustness of detection to one disturbance at increasing levels. Nothing is stored. */
export async function stressTest(req, res) {
  ok(res, await withSource(req, (source) => aiService.stressTest(source, req.valid.body)));
}

/** Noise-filtration preview for the Noise Filtration tab. Nothing is kept (direct uploads are deleted after). */
export async function filterPreview(req, res) {
  const { output } = req.valid.query;
  const stored = req.sonarRef ? await storageService.resolveDirectUpload(req.sonarRef) : undefined;
  try {
    const source = stored ? { url: stored.url, filename: req.sonarRef.filename } : req.file;
    const result = await aiService.filter(source, req.valid.body, output);
    if (output === 'jpeg') return res.type('image/jpeg').send(result);
    ok(res, result);
  } finally {
    if (stored) await storageService.remove(stored);
  }
}
