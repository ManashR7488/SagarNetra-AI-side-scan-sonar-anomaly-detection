import mongoose from 'mongoose';
import { Detection, Mission, Scan } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { DEFAULT_MISSION_NAME, SEVERITIES, SEVERITY_RANK } from '../utils/constants.js';
import { getPagination, paginationMeta } from '../utils/pagination.js';

export const missionService = {
  async list(query) {
    const p = getPagination(query);
    const filter = {};
    if (query.status) filter.status = query.status;
    if (query.search) filter.name = { $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const [data, total] = await Promise.all([
      Mission.find(filter).sort({ isDefault: 1, createdAt: -1 }).skip(p.skip).limit(p.limit),
      Mission.countDocuments(filter),
    ]);
    return { data, meta: paginationMeta(p, total) };
  },

  async get(id) {
    const mission = await Mission.findById(id);
    if (!mission) throw ApiError.notFound('Mission');
    return mission;
  },

  create: (data) => Mission.create(data),

  async update(id, data) {
    const mission = await Mission.findByIdAndUpdate(id, data, { returnDocument: 'after', runValidators: true });
    if (!mission) throw ApiError.notFound('Mission');
    return mission;
  },

  /** The auto-created mission that receives scans uploaded without a missionId. */
  async getDefault() {
    return Mission.findOneAndUpdate(
      { isDefault: true },
      { $setOnInsert: { name: DEFAULT_MISSION_NAME, isDefault: true, description: 'Scans uploaded without a mission' } },
      { upsert: true, returnDocument: 'after' },
    );
  },

  /** Recompute the denormalised counters on a mission from its scans and detections. */
  async refreshStats(missionId) {
    const id = new mongoose.Types.ObjectId(String(missionId));
    const [scanAgg] = await Scan.aggregate([
      { $match: { mission: id } },
      { $group: { _id: null, scans: { $sum: 1 }, lastScanAt: { $max: '$createdAt' } } },
    ]);
    const [detAgg] = await Detection.aggregate([
      { $match: { mission: id } },
      {
        $group: {
          _id: null,
          detections: { $sum: 1 },
          confirmed: { $sum: { $cond: [{ $eq: ['$status', 'confirmed'] }, 1, 0] } },
          hazards: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'confirmed'] }, '$isHazard'] }, 1, 0] } },
          severities: { $addToSet: { $cond: [{ $eq: ['$status', 'confirmed'] }, '$severity', 'none'] } },
        },
      },
    ]);
    const maxSeverity = (detAgg?.severities ?? ['none']).reduce(
      (a, b) => (SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a), SEVERITIES[0],
    );
    await Mission.updateOne({ _id: id }, {
      stats: {
        scans: scanAgg?.scans ?? 0,
        detections: detAgg?.detections ?? 0,
        confirmed: detAgg?.confirmed ?? 0,
        hazards: detAgg?.hazards ?? 0,
        maxSeverity,
        lastScanAt: scanAgg?.lastScanAt,
      },
    });
  },
};
