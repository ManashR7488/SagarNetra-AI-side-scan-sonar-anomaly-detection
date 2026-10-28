import mongoose from 'mongoose';
import { Detection } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { toCsv } from '../utils/csv.js';
import { getPagination, paginationMeta } from '../utils/pagination.js';

const EARTH_RADIUS_M = 6378100;
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const SORTS = { confidence: 'confidence', createdAt: 'createdAt', className: 'className', code: 'code' };

/** Build a Mongo filter from validated query parameters (see validators/detection.validator.js). */
export function buildFilter(q = {}) {
  const f = {};
  if (q.missionId) f.mission = oid(q.missionId);
  if (q.scanId) f.scan = oid(q.scanId);
  else if (!q.includeDrafts) f.draft = { $ne: true };        // drafts: only when asking for that scan
  if (q.className?.length) f.className = { $in: q.className };
  if (q.severity?.length) f.severity = { $in: q.severity };
  if (q.status) f.status = q.status;
  if (q.reviewStatus?.length) f['review.status'] = { $in: q.reviewStatus };
  if (q.hazardOnly) f.isHazard = true;
  if (q.minConfidence !== undefined || q.maxConfidence !== undefined) {
    f.confidence = {
      ...(q.minConfidence !== undefined && { $gte: q.minConfidence }),
      ...(q.maxConfidence !== undefined && { $lte: q.maxConfidence }),
    };
  }
  if (q.hasLocation) f.location = { $exists: true };
  if (q.bbox) {
    const [minLon, minLat, maxLon, maxLat] = q.bbox;
    f.location = { $geoWithin: { $box: [[minLon, minLat], [maxLon, maxLat]] } };
  }
  if (q.near) {
    // $geoWithin/$centerSphere (unlike $near) can be combined with countDocuments and custom sorting.
    f.location = { $geoWithin: { $centerSphere: [q.near, (q.radiusM ?? 1000) / EARTH_RADIUS_M] } };
  }
  if (q.from || q.to) f.createdAt = { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) };
  return f;
}

const CSV_COLUMNS = [
  { header: 'detection_id', value: (d) => d.id },
  { header: 'code', value: (d) => d.code },
  { header: 'mission', value: (d) => d.mission?.name ?? d.mission },
  { header: 'scan', value: (d) => d.scan?.name ?? d.scan },
  { header: 'source_file', value: (d) => d.scan?.source?.filename },
  { header: 'status', value: (d) => d.status },
  { header: 'class_name', value: (d) => d.className },
  { header: 'category', value: (d) => d.category },
  { header: 'severity', value: (d) => d.severity },
  { header: 'is_hazard', value: (d) => d.isHazard },
  { header: 'confidence_pct', value: (d) => d.confidence },
  { header: 'latitude', value: (d) => d.location?.coordinates?.[1] },
  { header: 'longitude', value: (d) => d.location?.coordinates?.[0] },
  { header: 'side', value: (d) => d.geo?.side },
  { header: 'across_track_m', value: (d) => d.geo?.acrossTrackM },
  { header: 'ping_time', value: (d) => d.geo?.timestamp },
  { header: 'bbox_x1', value: (d) => d.bbox?.x1 },
  { header: 'bbox_y1', value: (d) => d.bbox?.y1 },
  { header: 'bbox_x2', value: (d) => d.bbox?.x2 },
  { header: 'bbox_y2', value: (d) => d.bbox?.y2 },
  { header: 'width_px', value: (d) => d.bbox?.width },
  { header: 'height_px', value: (d) => d.bbox?.height },
  { header: 'across_track_extent_m', value: (d) => d.dimensions?.acrossTrackM },
  { header: 'along_track_extent_m', value: (d) => d.dimensions?.alongTrackM },
  { header: 'area_m2', value: (d) => d.dimensions?.areaM2 },
  { header: 'height_m', value: (d) => d.dimensions?.heightM },
  { header: 'height_method', value: (d) => d.dimensions?.heightMethod },
  { header: 'least_depth_m', value: (d) => d.dimensions?.leastDepthM },
  { header: 'source_model', value: (d) => d.sourceModel },
  { header: 'model_confidence', value: (d) => d.evidence?.modelConfidence },
  { header: 'shadow', value: (d) => d.evidence?.shadow },
  { header: 'linearity', value: (d) => d.evidence?.linearity },
  { header: 'contrast', value: (d) => d.evidence?.contrast },
  { header: 'suppression_reasons', value: (d) => d.suppressionReasons },
  { header: 'natural_label', value: (d) => d.natural?.label },
  { header: 'p_man_made', value: (d) => d.natural?.pManMade },
  { header: 'evidence_reasons', value: (d) => d.natural?.reasons?.join('; ') },
  { header: 'shadow_found', value: (d) => d.shadow?.found },
  { header: 'shadow_length_ratio', value: (d) => d.shadow?.lengthRatio },
  { header: 'data_quality_score', value: (d) => d.quality?.score },
  { header: 'data_quality_flags', value: (d) => d.quality?.flags },
  { header: 'review_status', value: (d) => d.review?.status },
  { header: 'ai_status', value: (d) => d.review?.aiStatus },
  { header: 'review_notes', value: (d) => d.review?.notes },
  { header: 'detected_at', value: (d) => d.createdAt },
];

export const detectionService = {
  async list(q) {
    const p = getPagination(q, 50);
    const filter = buildFilter(q);
    const sort = { [SORTS[q.sortBy] ?? 'confidence']: q.order === 'asc' ? 1 : -1, _id: 1 };
    const [data, total] = await Promise.all([
      Detection.find(filter).sort(sort).skip(p.skip).limit(p.limit)
        .populate('scan', 'name source.filename images.annotated.url')
        .populate('mission', 'name'),
      Detection.countDocuments(filter),
    ]);
    return { data, meta: paginationMeta(p, total) };
  },

  async get(id) {
    const d = await Detection.findById(id).populate('scan', 'name source images georeference').populate('mission', 'name');
    if (!d) throw ApiError.notFound('Detection');
    return d;
  },

  async updateReview(id, { status, notes, reviewedBy, origin }) {
    const update = {
      'review.status': status,
      'review.reviewedAt': new Date(),
      ...(notes !== undefined && { 'review.notes': notes }),
      ...(reviewedBy !== undefined && { 'review.reviewedBy': reviewedBy }),
      ...(origin !== undefined && { 'review.origin': origin }),
    };
    const d = await Detection.findByIdAndUpdate(id, update, { returnDocument: 'after', runValidators: true });
    if (!d) throw ApiError.notFound('Detection');
    return d;
  },

  /** GeoJSON FeatureCollection of geotagged detections for the map. */
  async geojson(q) {
    const filter = { ...buildFilter(q) };
    filter.location ??= { $exists: true };
    const docs = await Detection.find(filter).sort({ confidence: -1 }).limit(q.limit ?? 5000)
      .select('code className category severity isHazard confidence status review.status location dimensions scan mission geo.timestamp')
      .lean();
    return {
      type: 'FeatureCollection',
      features: docs.map((d) => ({
        type: 'Feature',
        id: String(d._id),
        geometry: d.location,
        properties: {
          id: String(d._id),
          code: d.code,
          className: d.className,
          category: d.category,
          severity: d.severity,
          isHazard: d.isHazard,
          confidence: d.confidence,
          status: d.status,
          reviewStatus: d.review?.status,
          dimensions: d.dimensions,
          scanId: String(d.scan),
          missionId: String(d.mission),
          detectedAt: d.geo?.timestamp,
        },
      })),
    };
  },

  /** Aggregations for the dashboard. */
  async stats(q) {
    const match = buildFilter(q);
    const [res] = await Detection.aggregate([
      { $match: match },
      {
        $facet: {
          totals: [{
            $group: {
              _id: null,
              detections: { $sum: 1 },
              confirmed: { $sum: { $cond: [{ $eq: ['$status', 'confirmed'] }, 1, 0] } },
              suppressed: { $sum: { $cond: [{ $eq: ['$status', 'suppressed'] }, 1, 0] } },
              hazards: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'confirmed'] }, '$isHazard'] }, 1, 0] } },
              geotagged: { $sum: { $cond: [{ $ifNull: ['$location', false] }, 1, 0] } },
              reviewed: { $sum: { $cond: [{ $ne: ['$review.status', 'unreviewed'] }, 1, 0] } },
              meanConfidence: { $avg: '$confidence' },
            },
          }],
          byClass: [
            { $match: { status: 'confirmed' } },
            { $group: { _id: '$className', category: { $first: '$category' }, count: { $sum: 1 }, meanConfidence: { $avg: '$confidence' } } },
            { $sort: { count: -1 } },
          ],
          bySeverity: [{ $match: { status: 'confirmed' } }, { $group: { _id: '$severity', count: { $sum: 1 } } }],
          byReview: [{ $group: { _id: '$review.status', count: { $sum: 1 } } }],
          suppressedByReason: [
            { $match: { status: 'suppressed' } }, { $unwind: '$suppressionReasons' },
            { $group: { _id: '$suppressionReasons', count: { $sum: 1 } } }, { $sort: { count: -1 } },
          ],
          confidenceHistogram: [
            { $bucket: { groupBy: '$confidence', boundaries: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100.0001], default: 'other', output: { count: { $sum: 1 } } } },
          ],
          timeline: [
            { $match: { status: 'confirmed' } },
            { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
            { $sort: { _id: 1 } },
          ],
        },
      },
    ]);
    const t = res.totals[0] ?? { detections: 0, confirmed: 0, suppressed: 0, hazards: 0, geotagged: 0, reviewed: 0, meanConfidence: null };
    const pairs = (arr) => arr.map(({ _id, ...rest }) => ({ key: _id, ...rest }));
    return {
      totals: { ...t, _id: undefined, meanConfidence: t.meanConfidence === null ? null : Math.round(t.meanConfidence * 10) / 10 },
      byClass: res.byClass.map(({ _id, meanConfidence, ...r }) => ({ className: _id, ...r, meanConfidence: Math.round(meanConfidence * 10) / 10 })),
      bySeverity: pairs(res.bySeverity),
      byReview: pairs(res.byReview),
      suppressedByReason: pairs(res.suppressedByReason),
      confidenceHistogram: res.confidenceHistogram.map((b) => ({ from: b._id, to: b._id === 'other' ? null : Math.min(100, b._id + 10), count: b.count })),
      timeline: res.timeline.map((d) => ({ date: d._id, count: d.count })),
    };
  },

  async exportCsv(q) {
    const docs = await Detection.find(buildFilter(q)).sort({ mission: 1, scan: 1, code: 1 }).limit(50000)
      .populate('scan', 'name source.filename').populate('mission', 'name');
    return toCsv(docs, CSV_COLUMNS);
  },
};
