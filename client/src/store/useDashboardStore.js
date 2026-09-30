import { create } from 'zustand';
import { detectionsApi } from '../api';
import { errorMessage } from '../config/axios';

/** Dashboard: aggregated detection stats + latest detections for the active mission (or all). */
export const useDashboardStore = create((set) => ({
  stats: null,
  recent: [],
  loading: false,
  error: null,

  fetch: async (missionId) => {
    set({ loading: true });
    try {
      const params = { missionId: missionId ?? undefined };
      const [stats, recent] = await Promise.all([
        detectionsApi.stats(params),
        detectionsApi.list({ ...params, status: 'confirmed', sortBy: 'createdAt', order: 'desc', limit: 25 }),
      ]);
      set({ stats, recent: recent.data, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: errorMessage(err) });
    }
  },
}));
