import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middlewares/validate.js';
import { storageService } from '../services/storage.service.js';
import { ok } from '../utils/response.js';

const router = Router();

const signBody = z.object({
  filename: z.string().trim().min(1).max(200).regex(/\.(png|jpe?g|bmp|tiff?|webp|xtf)$/i, 'must be a sonar image or .xtf file'),
});

/**
 * POST /api/uploads/sign { filename } -> { uploadUrl, resourceType, fields }
 * The browser posts the file plus `fields` to `uploadUrl` (Cloudinary), then sends the returned
 * public_id to /api/scans as `fileRef`. 409 DIRECT_UPLOAD_DISABLED when storage is local.
 */
router.post('/sign', validate({ body: signBody }), (req, res) => {
  ok(res, storageService.signDirectUpload(req.valid.body.filename));
});

export default router;
