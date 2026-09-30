import { detectionService } from '../services/detection.service.js';
import { scanService } from '../services/scan.service.js';
import { created, ok } from '../utils/response.js';

/** POST /api/scans: upload + analyse + store. Responds when the analysis is finished. */
export async function createScan(req, res) {
  const { missionId, name, options } = req.valid.body;
  const scan = await scanService.create({
    file: req.sonarFile, fileRef: req.sonarRef, metadata: req.metadataFile, missionId, name, options,
  });
  created(res, scan);
}

export async function reanalyzeScan(req, res) {
  ok(res, await scanService.reanalyze(req.valid.params.id, req.valid.body));
}

export async function listScans(req, res) {
  const { data, meta } = await scanService.list(req.valid.query);
  ok(res, data, meta);
}

export async function getScan(req, res) {
  ok(res, await scanService.get(req.valid.params.id, req.valid.query));
}

export async function deleteScan(req, res) {
  await scanService.remove(req.valid.params.id);
  res.status(204).end();
}

export async function scanReportJson(req, res) {
  const scan = await scanService.get(req.valid.params.id);
  res.attachment(`scan_${scan.id}_report.json`).json(scan);
}

export async function scanReportCsv(req, res) {
  const scan = await scanService.get(req.valid.params.id, { includeSuppressed: false });
  const csv = await detectionService.exportCsv({ scanId: scan.id });
  res.attachment(`scan_${scan.id}_detections.csv`).type('text/csv').send(csv);
}
