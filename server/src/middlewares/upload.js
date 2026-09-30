import path from 'node:path';
import multer from 'multer';
import { config } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

const SONAR_EXT = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp', '.xtf']);
const METADATA_EXT = new Set(['.csv', '.json', '.txt']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.upload.maxBytes, files: 2, fields: 50 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = file.fieldname === 'metadata' ? METADATA_EXT : SONAR_EXT;
    if (!allowed.has(ext)) {
      return cb(new ApiError(415, `Unsupported ${file.fieldname} file type "${ext || 'none'}". Allowed: ${[...allowed].join(', ')}`));
    }
    cb(null, true);
  },
});

/**
 * A file uploaded straight to Cloudinary by the browser (see POST /api/uploads/sign), sent as the JSON
 * field `fileRef`: { publicId, resourceType, filename }. Resolved server-side, never trusted as a URL.
 */
function readFileRef(req) {
  const raw = req.body?.fileRef;
  if (!raw) return undefined;
  let ref;
  try {
    ref = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw ApiError.badRequest('fileRef must be JSON');
  }
  const ext = path.extname(ref?.filename ?? '').toLowerCase();
  if (typeof ref?.publicId !== 'string' || !SONAR_EXT.has(ext)) {
    throw new ApiError(415, `fileRef needs a publicId and a sonar file name (${[...SONAR_EXT].join(', ')})`);
  }
  delete req.body.fileRef;
  return { publicId: ref.publicId, resourceType: ref.resourceType, filename: path.basename(ref.filename) };
}

/** multipart: `file` (sonar image or .xtf) or `fileRef`, + optional `metadata` (navigation CSV/JSON). */
export const sonarUpload = [
  upload.fields([{ name: 'file', maxCount: 1 }, { name: 'metadata', maxCount: 1 }]),
  (req, _res, next) => {
    try {
      req.sonarFile = req.files?.file?.[0];
      req.sonarRef = req.sonarFile ? undefined : readFileRef(req);
    } catch (err) {
      return next(err);
    }
    req.metadataFile = req.files?.metadata?.[0];
    if (!req.sonarFile && !req.sonarRef) return next(ApiError.badRequest('A sonar file is required in the "file" field'));
    next();
  },
];

/** multipart: `file` or `fileRef` (noise-filtration preview). */
export const singleSonarUpload = [
  upload.single('file'),
  (req, _res, next) => {
    try {
      req.sonarRef = req.file ? undefined : readFileRef(req);
    } catch (err) {
      return next(err);
    }
    return req.file || req.sonarRef ? next() : next(ApiError.badRequest('A sonar file is required in the "file" field'));
  },
];
