import { Router } from 'express';
import {
  createScan, deleteScan, getScan, listScans, publishScan, reanalyzeScan, scanReportCsv, scanReportJson,
} from '../controllers/scan.controller.js';
import { analysisLimiter } from '../middlewares/rateLimiter.js';
import { sonarUpload } from '../middlewares/upload.js';
import { validate } from '../middlewares/validate.js';
import { idParams } from '../validators/common.js';
import {
  createScanBody, getScanQuery, listScansQuery, publishBody, reanalyzeBody,
} from '../validators/scan.validator.js';

const router = Router();

router.route('/')
  .get(validate({ query: listScansQuery }), listScans)
  .post(analysisLimiter, sonarUpload, validate({ body: createScanBody }), createScan);

router.route('/:id')
  .get(validate({ params: idParams, query: getScanQuery }), getScan)
  .delete(validate({ params: idParams }), deleteScan);

router.post('/:id/reanalyze', analysisLimiter, validate({ params: idParams, body: reanalyzeBody }), reanalyzeScan);
router.post('/:id/publish', validate({ params: idParams, body: publishBody }), publishScan);
router.get('/:id/report.json', validate({ params: idParams }), scanReportJson);
router.get('/:id/report.csv', validate({ params: idParams }), scanReportCsv);

export default router;
