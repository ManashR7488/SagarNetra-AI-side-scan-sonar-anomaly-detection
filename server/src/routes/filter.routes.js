import { Router } from 'express';
import { filterPreview } from '../controllers/filter.controller.js';
import { singleSonarUpload } from '../middlewares/upload.js';
import { validate } from '../middlewares/validate.js';
import { filterPreviewBody, filterPreviewQuery } from '../validators/scan.validator.js';

const router = Router();

router.post('/', singleSonarUpload, validate({ query: filterPreviewQuery, body: filterPreviewBody }), filterPreview);

export default router;
