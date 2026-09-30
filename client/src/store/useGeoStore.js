import { create } from 'zustand';
import { detectionsApi } from '../api';
import { errorMessage } from '../config/axios';
import { toast } from './useToastStore';

const DEFAULT_FILTERS = {
  className: [],
  severity: [],
  status: 'confirmed',
  reviewStatus: [],
  minConfidence: 0,
  hazardOnly: true,
};

/** Geo Tag tab: geotagged detections of the active mission, route start point and operator review. */
export const useGeoStore = create((set, get) => ({
  filters: DEFAULT_FILTERS,
  detections: [],
  total: 0,
  loading: false,
  error: null,
  selectedId: null,
  startPointId: 'auto',
  showRoute: true,
  excludeCleared: true,     // cleared / false-positive targets are not part of the cleanup route

  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  resetFilters: () => set({ filters: DEFAULT_FILTERS }),
  select: (id) => set({ selectedId: id }),
  setStartPoint: (id) => set({ startPointId: id }),
  setShowRoute: (v) => set({ showRoute: v }),
  setExcludeCleared: (v) => set({ excludeCleared: v }),

  fetch: async (missionId) => {
    set({ loading: true });
    try {
      const { filters } = get();
      const { data, meta } = await detectionsApi.list({
        missionId: missionId ?? undefined,
        hasLocation: true,
        ...filters,
        minConfidence: filters.minConfidence || undefined,
        hazardOnly: filters.hazardOnly || undefined,
        sortBy: 'confidence',
        limit: 1000,
      });
      set((s) => ({
        detections: data,
        total: meta.total,
        loading: false,
        error: null,
        selectedId: data.some((d) => d.id === s.selectedId) ? s.selectedId : data[0]?.id ?? null,
        startPointId: data.some((d) => d.id === s.startPointId) ? s.startPointId : 'auto',
      }));
    } catch (err) {
      set({ loading: false, error: errorMessage(err) });
    }
  },

  review: async (id, status, notes) => {
    try {
      const updated = await detectionsApi.review(id, { status, ...(notes ? { notes } : {}) });
      set((s) => ({ detections: s.detections.map((d) => (d.id === id ? { ...d, review: updated.review } : d)) }));
      toast.success(`${updated.code}: marked ${status.replace('_', ' ')}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  },
}));
