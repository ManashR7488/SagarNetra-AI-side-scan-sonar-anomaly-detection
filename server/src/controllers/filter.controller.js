import { aiService } from '../services/ai.service.js';
import { storageService } from '../services/storage.service.js';
import { ok } from '../utils/response.js';

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
