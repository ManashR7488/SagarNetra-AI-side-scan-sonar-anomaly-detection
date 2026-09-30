import { Router } from 'express';
import {
  detectionStats, detectionsGeoJson, exportDetectionsCsv, getDetection, listDetections, reviewDetection,
} from '../controllers/detection.controller.js';
import { validate } from '../middlewares/validate.js';
import { idParams } from '../validators/common.js';
import { detectionQuery, reviewBody } from '../validators/detection.validator.js';

const router = Router();

router.get('/', validate({ query: detectionQuery }), listDetections);
router.get('/geojson', validate({ query: detectionQuery }), detectionsGeoJson);
router.get('/stats', validate({ query: detectionQuery }), detectionStats);
router.get('/export.csv', validate({ query: detectionQuery }), exportDetectionsCsv);
router.get('/:id', validate({ params: idParams }), getDetection);
router.patch('/:id/review', validate({ params: idParams, body: reviewBody }), reviewDetection);

export default router;
