import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cloudinary } from '../config/cloudinary.js';
import { config } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';

const IMAGE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff', 'webp']);

const extOf = (filename = '') => path.extname(filename).slice(1).toLowerCase();
const safeName = (name) => name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);

function uploadToCloudinary(buffer, { folder, name, resourceType }) {
  const ext = extOf(name);
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `${config.storage.cloudinary.folder}/${folder}`,
        // raw assets keep their extension in the public id; images get their format from Cloudinary
        public_id: resourceType === 'raw' ? safeName(name) : safeName(path.parse(name).name),
        resource_type: resourceType,
        overwrite: true,
      },
      (err, result) => (err ? reject(err) : resolve({
        provider: 'cloudinary',
        url: result.secure_url,
        publicId: result.public_id,
        resourceType,
        format: result.format ?? ext,
        bytes: result.bytes,
        width: result.width,
        height: result.height,
      })),
    );
    stream.end(buffer);
  });
}

async function uploadToLocal(buffer, { folder, name, resourceType }) {
  const rel = path.posix.join(folder, safeName(name));
  const abs = path.join(config.storage.localDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buffer);
  return {
    provider: 'local',
    url: `${config.publicUrl}/uploads/${rel}`,
    publicId: rel,
    resourceType,
    format: extOf(name),
    bytes: buffer.length,
  };
}

const incomingFolder = () => `${config.storage.cloudinary.folder}/incoming`;

export const storageService = {
  get provider() {
    return config.storage.provider;
  },

  resourceTypeFor: (filename) => (IMAGE_FORMATS.has(extOf(filename)) ? 'image' : 'raw'),

  /** Store a buffer under `folder/name`. Returns a storedFile sub-document. */
  async upload(buffer, { folder, name, resourceType }) {
    const type = resourceType ?? this.resourceTypeFor(name);
    return config.storage.provider === 'cloudinary'
      ? uploadToCloudinary(buffer, { folder, name, resourceType: type })
      : uploadToLocal(buffer, { folder, name, resourceType: type });
  },

  /** Large files skip the API (4.5 MB request limit on Vercel): the browser uploads them to Cloudinary. */
  get directUploads() {
    return config.storage.provider === 'cloudinary';
  },

  /** Signed parameters for one browser -> Cloudinary upload into the "incoming" folder. */
  signDirectUpload(filename) {
    if (!this.directUploads) {
      throw new ApiError(409, 'Direct uploads need Cloudinary storage; send the file to /api/scans instead', { code: 'DIRECT_UPLOAD_DISABLED' });
    }
    const resourceType = this.resourceTypeFor(filename);
    const base = `${randomUUID().slice(0, 8)}_${safeName(resourceType === 'raw' ? filename : path.parse(filename).name)}`;
    // Folder path inside public_id: same result for Cloudinary's fixed and dynamic folder modes.
    const params = { public_id: `${incomingFolder()}/${base}`, timestamp: Math.round(Date.now() / 1000) };
    const { cloudName, apiKey, apiSecret } = config.storage.cloudinary;
    return {
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`,
      resourceType,
      fields: { ...params, api_key: apiKey, signature: cloudinary.utils.api_sign_request(params, apiSecret) },
    };
  },

  /**
   * Turn a browser upload reference into a storedFile. The asset is looked up with the Admin API, so only
   * files that really are in our "incoming" folder are accepted (never an arbitrary URL from the client).
   */
  async resolveDirectUpload(ref) {
    if (!this.directUploads) throw new ApiError(409, 'Direct uploads are not enabled', { code: 'DIRECT_UPLOAD_DISABLED' });
    if (!ref?.publicId?.startsWith(`${incomingFolder()}/`)) throw ApiError.badRequest('Invalid uploaded file reference');
    const resourceType = ref.resourceType === 'raw' ? 'raw' : 'image';
    let r;
    try {
      r = await cloudinary.api.resource(ref.publicId, { resource_type: resourceType });
    } catch (err) {
      throw ApiError.badRequest(`Uploaded file not found (${err.error?.message ?? err.message})`);
    }
    return {
      provider: 'cloudinary',
      url: r.secure_url,
      publicId: r.public_id,
      resourceType,
      format: r.format ?? extOf(ref.filename),
      bytes: r.bytes,
      width: r.width,
      height: r.height,
    };
  },

  /** Download a stored file back into memory (used for re-analysis). */
  async download(file) {
    if (file.provider === 'local') return fs.readFile(path.join(config.storage.localDir, file.publicId));
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`Download failed (${res.status}) for ${file.url}`);
    return Buffer.from(await res.arrayBuffer());
  },

  /** Best-effort delete; never throws (a leftover asset must not block deleting DB records). */
  async remove(file) {
    if (!file?.publicId) return;
    try {
      if (file.provider === 'cloudinary') {
        await cloudinary.uploader.destroy(file.publicId, { resource_type: file.resourceType ?? 'image', invalidate: true });
      } else {
        await fs.rm(path.join(config.storage.localDir, file.publicId), { force: true });
      }
    } catch (err) {
      logger.warn(`Could not delete stored file ${file.publicId}: ${err.message}`);
    }
  },

  removeMany(files) {
    return Promise.all(files.filter(Boolean).map((f) => this.remove(f)));
  },
};
