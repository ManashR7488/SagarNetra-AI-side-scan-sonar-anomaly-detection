import { detectionService } from '../services/detection.service.js';
import { ok } from '../utils/response.js';

export async function listDetections(req, res) {
  const { data, meta } = await detectionService.list(req.valid.query);
  ok(res, data, meta);
}

export async function detectionsGeoJson(req, res) {
  res.type('application/geo+json').json(await detectionService.geojson(req.valid.query));
}

export async function detectionStats(req, res) {
  ok(res, await detectionService.stats(req.valid.query));
}

export async function exportDetectionsCsv(req, res) {
  res.attachment(`detections_${new Date().toISOString().slice(0, 10)}.csv`).type('text/csv')
    .send(await detectionService.exportCsv(req.valid.query));
}

export async function getDetection(req, res) {
  ok(res, await detectionService.get(req.valid.params.id));
}

export async function reviewDetection(req, res) {
  ok(res, await detectionService.updateReview(req.valid.params.id, req.valid.body));
}
