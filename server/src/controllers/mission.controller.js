import { detectionService } from '../services/detection.service.js';
import { missionService } from '../services/mission.service.js';
import { scanService } from '../services/scan.service.js';
import { created, ok } from '../utils/response.js';

export async function listMissions(req, res) {
  const { data, meta } = await missionService.list(req.valid.query);
  ok(res, data, meta);
}

export async function getMission(req, res) {
  ok(res, await missionService.get(req.valid.params.id));
}

export async function createMission(req, res) {
  created(res, await missionService.create(req.valid.body));
}

export async function updateMission(req, res) {
  ok(res, await missionService.update(req.valid.params.id, req.valid.body));
}

/** Deletes the mission with all its scans, detections and stored files. */
export async function deleteMission(req, res) {
  const mission = await missionService.get(req.valid.params.id);
  await scanService.removeByMission(mission._id);
  await mission.deleteOne();
  res.status(204).end();
}

export async function missionReportCsv(req, res) {
  const mission = await missionService.get(req.valid.params.id);
  const csv = await detectionService.exportCsv({ missionId: mission.id });
  res.attachment(`mission_${mission.name.replace(/\W+/g, '_')}_detections.csv`).type('text/csv').send(csv);
}
