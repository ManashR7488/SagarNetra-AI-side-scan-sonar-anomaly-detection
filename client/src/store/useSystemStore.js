import { create } from 'zustand';
import { systemApi } from '../api';
import { errorMessage } from '../config/axios';

/** Backend / AI service / database health and the AI model cards. */
export const useSystemStore = create((set, get) => ({
  health: null,        // { status, database, aiService: {...}, storage: {...} }
  healthError: null,
  models: null,        // { detector: modelCard, segmenter: modelCard }
  modelsError: null,

  fetchHealth: async () => {
    try {
      set({ health: await systemApi.health(), healthError: null });
    } catch (err) {
      set({ health: null, healthError: errorMessage(err) });
    }
  },

  fetchModels: async (force = false) => {
    if (get().models && !force) return get().models;
    try {
      const models = await systemApi.models();
      set({ models, modelsError: null });
      return models;
    } catch (err) {
      set({ modelsError: errorMessage(err) });
      return null;
    }
  },

  /** Poll health every `ms`; returns a stop function (use inside useEffect). */
  startPolling: (ms = 30000) => {
    get().fetchHealth();
    const timer = setInterval(() => get().fetchHealth(), ms);
    return () => clearInterval(timer);
  },
}));
