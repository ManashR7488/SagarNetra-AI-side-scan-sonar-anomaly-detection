import path from 'node:path';
import { Detection, Scan } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { DRAFT_TTL_MS, NATURAL_REASON, SCORE_REASONS, SEVERITY_RANK } from '../utils/constants.js';
import { logger } from '../utils/logger.js';
import { detectionFromAi, scanFieldsFromAi, seabedFromAi } from '../utils/mappers.js';
import { getPagination, paginationMeta } from '../utils/pagination.js';
import { aiService, dataUrlToBuffer } from './ai.service.js';
import { missionService } from './mission.service.js';
import { storageService } from './storage.service.js';

const folderFor = (scan) => `missions/${scan.mission}/scans/${scan.id}`;

/** Fill georeference gaps from the mission's defaults (e.g. swath width of the sonar used on the survey). */
function withMissionDefaults(options, mission) {
  const georef = { ...(options.georef ?? {}) };
  if (georef.latitude !== undefined && georef.longitude !== undefined) {
    georef.swathWidthM ??= mission.defaults?.swathWidthM;
    georef.headingDeg ??= mission.defaults?.headingDeg;
  }
  return { ...options, georef };
}

/**
 * Upload the original (in parallel with the AI call), analyse, store result images, save detections.
 * `file` / `metadata` are multer-like objects; `stored*` are already-stored files (re-analysis and
 * direct browser uploads). Files already in Cloudinary are passed to the AI service by URL.
 */
const aiInput = (file, stored, filename) => (stored?.provider === 'cloudinary' ? { url: stored.url, filename } : file);

async function runPipeline(scan, { file, metadata, storedOriginal, storedMetadata }) {
  const started = Date.now();
  const folder = folderFor(scan);
  const warnings = [];
  const storeSafely = async (buffer, name, label, resourceType) => {
    try {
      return await storageService.upload(buffer, { folder, name, resourceType });
    } catch (err) {
      warnings.push(`${label} was not stored: ${err.message}`);
      logger.warn(`scan ${scan.id}: ${label} upload failed: ${err.message}`);
      return undefined;
    }
  };

  // Upload the original while the AI works. allSettled: even if the analysis fails, the stored original
  // is recorded so the scan can be re-analysed later (storeSafely never rejects).
  const [ai, original, metadataFile] = await Promise.allSettled([
    aiService.analyze(
      aiInput(file, storedOriginal, scan.source.filename),
      metadata || storedMetadata ? aiInput(metadata, storedMetadata, scan.source.metadataFile?.filename) : undefined,
      scan.options,
    ),
    storedOriginal ?? storeSafely(file.buffer, `original${path.extname(file.originalname).toLowerCase()}`, 'Original file'),
    storedMetadata ?? (metadata ? storeSafely(metadata.buffer, `metadata_${metadata.originalname}`, 'Metadata file') : undefined),
  ]);
  scan.set({ 'source.file': original.value, 'source.metadataFile.file': metadataFile.value });
  if (ai.status === 'rejected') throw ai.reason;
  const result = ai.value;

  // Inline images (always requested); the image endpoints are a fallback for older AI services.
  const [annotatedBuf, filteredBuf] = await Promise.all(['annotated', 'filtered'].map((kind) => (
    dataUrlToBuffer(result.images?.[kind]) ?? aiService.image(result.analysis_id, kind)
  )));
  delete result.images;
  const seabed = seabedFromAi(result.seabed);
  const [annotated, filtered, elevationFile, textureFile] = await Promise.all([
    storeSafely(annotatedBuf, 'annotated.jpg', 'Annotated image'),
    storeSafely(filteredBuf, 'filtered.jpg', 'Filtered image'),
    seabed.available
      ? storeSafely(Buffer.from(result.seabed.elevation.data, 'base64'), 'seabed-elevation.bin', '3D seabed heightfield', 'raw')
      : undefined,
    seabed.available ? storeSafely(dataUrlToBuffer(result.seabed.texture), 'seabed-texture.jpg', '3D seabed texture') : undefined,
  ]);
  if (seabed.available && (!elevationFile || !textureFile)) {
    Object.assign(seabed, { available: false, reason: 'The 3D seabed files could not be stored' });
  }
  if (seabed.available) {
    seabed.elevation.file = elevationFile;
    seabed.texture = textureFile;
  }
  delete result.seabed;

  await Detection.deleteMany({ scan: scan._id }); // re-analysis replaces previous detections
  const docs = (result.detections ?? []).map((d) => detectionFromAi(d, { scanId: scan._id, missionId: scan.mission, draft: scan.draft }));
  if (docs.length) await Detection.insertMany(docs);

  scan.set({
    ...scanFieldsFromAi(result),
    status: 'completed',
    error: undefined,
    warnings,
    'images.annotated': annotated,
    'images.filtered': filtered,
    seabed,
    'processing.completedAt': new Date(),
    'processing.durationMs': Date.now() - started,
  });
  await scan.save();
}

async function execute(scan, inputs) {
  try {
    await runPipeline(scan, inputs);
  } catch (err) {
    scan.set({
      status: 'failed',
      error: { message: err.message, code: err.code ?? 'ANALYSIS_FAILED', status: err.status ?? 500 },
      'processing.completedAt': new Date(),
    });
    await scan.save().catch((e) => logger.error('Could not record scan failure', e));
    if (err instanceof ApiError) err.details = { ...(err.details ?? {}), scanId: scan.id };
    throw err;
  } finally {
    await missionService.refreshStats(scan.mission);
  }
}

/** Final status of a detection for a threshold and the operator's review (the AI's own decision is kept). */
function decideStatus(d, minScore) {
  const aiReasons = d.suppressionReasons.filter((r) => !SCORE_REASONS.includes(r) && r !== 'operator_rejected');
  if (d.confidence < minScore) {
    aiReasons.push('below_min_score');
    const natural = NATURAL_REASON[d.natural?.label];
    if (natural) aiReasons.push(natural);
  }
  const aiStatus = aiReasons.length ? 'suppressed' : 'confirmed';
  if (d.review?.status === 'verified') return { status: 'confirmed', suppressionReasons: [], aiStatus };
  if (d.review?.status === 'false_positive') return { status: 'suppressed', suppressionReasons: [...aiReasons, 'operator_rejected'], aiStatus };
  return { status: aiStatus, suppressionReasons: aiReasons, aiStatus };
}

/** Scan summary recomputed from its stored detections (after a threshold change or operator review). */
function summaryFrom(detections, previous = {}) {
  const confirmed = detections.filter((d) => d.status === 'confirmed');
  const byClass = {};
  for (const d of confirmed) byClass[d.className] = (byClass[d.className] ?? 0) + 1;
  const suppressedByReason = {};
  for (const d of detections) for (const r of d.suppressionReasons) suppressedByReason[r] = (suppressedByReason[r] ?? 0) + 1;
  const hazards = confirmed.filter((d) => d.isHazard);
  const maxSeverity = hazards.reduce((a, d) => (SEVERITY_RANK[d.severity] > SEVERITY_RANK[a] ? d.severity : a), 'none');
  return {
    candidates: previous.candidates ?? detections.length,
    confirmed: confirmed.length,
    suppressed: detections.length - confirmed.length,
    hazards: hazards.length,
    byClass,
    suppressedByReason,
    maxSeverity,
    meanConfidence: confirmed.length ? Math.round((confirmed.reduce((a, d) => a + d.confidence, 0) / confirmed.length) * 10) / 10 : undefined,
  };
}

export const scanService = {
  /** Create a scan from an upload and analyse it (synchronously). `draft`: Noise Filtration review. */
  async create({ file, fileRef, metadata, missionId, name, options, draft = false }) {
    if (draft) this.removeStaleDrafts().catch((err) => logger.warn(`draft cleanup failed: ${err.message}`));
    const mission = missionId ? await missionService.get(missionId) : await missionService.getDefault();
    // A large file the browser already uploaded to Cloudinary: verify it, then treat it as stored.
    const storedOriginal = fileRef ? await storageService.resolveDirectUpload(fileRef) : undefined;
    const filename = file?.originalname ?? fileRef.filename;
    const scan = await Scan.create({
      mission: mission._id,
      name: name || filename,
      status: 'processing',
      draft,
      review: draft ? { origin: 'noise_filtration' } : undefined,
      source: {
        filename,
        format: path.extname(filename).slice(1).toLowerCase(),
        mimeType: file?.mimetype,
        sizeBytes: file ? file.size ?? file.buffer.length : storedOriginal.bytes,
        metadataFile: metadata ? { filename: metadata.originalname } : undefined,
      },
      options: withMissionDefaults(options, mission),
      processing: { startedAt: new Date() },
    });
    await execute(scan, { file, metadata, storedOriginal });
    return this.get(scan.id);
  },

  /** Re-run the AI on the stored original with new options (e.g. different filter or georeference). */
  async reanalyze(id, options) {
    const scan = await Scan.findById(id).populate('mission');
    if (!scan) throw ApiError.notFound('Scan');
    if (!scan.source.file) throw new ApiError(409, 'The original file of this scan was not stored; upload it again');
    const mission = scan.mission;
    scan.mission = mission._id;

    // Cloudinary files go to the AI service by URL; local files are read back from disk.
    const cloud = scan.source.file.provider === 'cloudinary';
    const readStored = (f) => storageService.download(f).catch((err) => {
      if (err.code === 'ENOENT') throw new ApiError(409, 'The stored original of this scan is missing; upload it again');
      throw err;
    });
    const file = cloud ? undefined : {
      buffer: await readStored(scan.source.file), originalname: scan.source.filename, mimetype: scan.source.mimeType,
    };
    let metadata;
    const metaFile = scan.source.metadataFile?.file;
    if (metaFile && metaFile.provider !== 'cloudinary') {
      metadata = { buffer: await storageService.download(metaFile), originalname: scan.source.metadataFile.filename };
    }
    scan.set({
      status: 'processing',
      error: undefined,
      options: withMissionDefaults({ ...scan.options.toObject(), ...options }, mission),
      'processing.startedAt': new Date(),
    });
    await scan.save();
    await execute(scan, { file, metadata, storedOriginal: scan.source.file, storedMetadata: metaFile });
    return this.get(scan.id);
  },

  /**
   * Publish a reviewed draft: apply the threshold chosen in the review and the operator's confirm / reject decisions
   * to every detection, then make the scan (and its detections) visible to AI Detection, the map and statistics.
   */
  async publish(id, { minScore, name } = {}) {
    const scan = await Scan.findById(id);
    if (!scan) throw ApiError.notFound('Scan');
    if (scan.status !== 'completed') throw new ApiError(409, 'Only a completed analysis can be published');
    const threshold = minScore ?? scan.options?.minScore ?? 50;
    const detections = await Detection.find({ scan: scan._id });
    for (const d of detections) {
      const { status, suppressionReasons, aiStatus } = decideStatus(d, threshold);
      d.set({ status, suppressionReasons, draft: false, 'review.aiStatus': aiStatus });
      if (d.review?.status !== 'unreviewed' && !d.review?.origin) d.set('review.origin', 'noise_filtration');
    }
    await Promise.all(detections.map((d) => d.save()));
    scan.set({
      draft: false,
      name: name ?? scan.name,
      summary: summaryFrom(detections, scan.summary),
      'options.minScore': threshold,
      review: { origin: 'noise_filtration', minScore: threshold, publishedAt: new Date() },
    });
    await scan.save();
    await missionService.refreshStats(scan.mission);
    return this.get(scan.id);
  },

  /** Drafts nobody sent to AI Detection are removed after DRAFT_TTL_MS (files, detections and all). */
  async removeStaleDrafts() {
    const stale = await Scan.find({ draft: true, createdAt: { $lt: new Date(Date.now() - DRAFT_TTL_MS) } }, '_id');
    for (const s of stale) await this.remove(s._id);
    return stale.length;
  },

  async list(query) {
    const p = getPagination(query);
    const filter = {};
    if (query.missionId) filter.mission = query.missionId;
    if (query.status) filter.status = query.status;
    if (!query.includeDrafts) filter.draft = { $ne: true };
    const [data, total] = await Promise.all([
      // The 3D seabed's track samples and targets are only needed for one scan (GET /scans/:id).
      Scan.find(filter).select('-seabed.track -seabed.targets -seabed.methods').sort({ createdAt: -1 })
        .skip(p.skip).limit(p.limit).populate('mission', 'name'),
      Scan.countDocuments(filter),
    ]);
    return { data, meta: paginationMeta(p, total) };
  },

  async get(id, { includeSuppressed = true } = {}) {
    const scan = await Scan.findById(id).populate('mission', 'name status');
    if (!scan) throw ApiError.notFound('Scan');
    const filter = { scan: scan._id, ...(includeSuppressed ? {} : { status: 'confirmed' }) };
    const detections = await Detection.find(filter).sort({ status: 1, confidence: -1 });
    return { ...scan.toJSON(), detections };
  },

  async remove(id) {
    const scan = await Scan.findById(id);
    if (!scan) throw ApiError.notFound('Scan');
    await Detection.deleteMany({ scan: scan._id });
    await scan.deleteOne();
    await storageService.removeMany([
      scan.source?.file, scan.source?.metadataFile?.file, scan.images?.annotated, scan.images?.filtered,
      scan.seabed?.elevation?.file, scan.seabed?.texture,
    ]);
    await missionService.refreshStats(scan.mission);
  },

  async removeByMission(missionId) {
    const scans = await Scan.find({ mission: missionId }, '_id');
    for (const s of scans) await this.remove(s._id);
  },
};
