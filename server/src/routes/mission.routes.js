import { Router } from 'express';
import {
  createMission, deleteMission, getMission, listMissions, missionReportCsv, updateMission,
} from '../controllers/mission.controller.js';
import { validate } from '../middlewares/validate.js';
import { idParams } from '../validators/common.js';
import { createMissionBody, listMissionsQuery, updateMissionBody } from '../validators/mission.validator.js';

const router = Router();

router.route('/')
  .get(validate({ query: listMissionsQuery }), listMissions)
  .post(validate({ body: createMissionBody }), createMission);

router.route('/:id')
  .get(validate({ params: idParams }), getMission)
  .patch(validate({ params: idParams, body: updateMissionBody }), updateMission)
  .delete(validate({ params: idParams }), deleteMission);

router.get('/:id/report.csv', validate({ params: idParams }), missionReportCsv);

export default router;
