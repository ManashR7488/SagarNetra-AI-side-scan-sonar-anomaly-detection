import { Router } from 'express';
import { cleanPreview, filterPreview, stressTest } from '../controllers/filter.controller.js';
import { analysisLimiter } from '../middlewares/rateLimiter.js';
import { singleSonarUpload } from '../middlewares/upload.js';
import { validate } from '../middlewares/validate.js';
import {
  cleanPreviewBody, cleanPreviewQuery, filterPreviewBody, filterPreviewQuery, stressBody,
} from '../validators/scan.validator.js';

const router = Router();

router.post('/', singleSonarUpload, validate({ query: filterPreviewQuery, body: filterPreviewBody }), filterPreview);
// noise-filtering module: stage 1 (clean + noise report) and stage 3 (stress test); stage 2 uses draft scans
router.post('/clean', singleSonarUpload, validate({ query: cleanPreviewQuery, body: cleanPreviewBody }), cleanPreview);
router.post('/stress', analysisLimiter, singleSonarUpload, validate({ body: stressBody }), stressTest);

export default router;
