import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { missionsApi } from '../api';
import { errorMessage } from '../config/axios';
import { toast } from './useToastStore';

/**
 * Survey missions. `activeMissionId` scopes every tab (uploads go to it; map/dashboard show it).
 * null = "All missions" for viewing; uploads then go to the backend's default "General Survey".
 */
export const useMissionStore = create(
  persist(
    (set, get) => ({
      missions: [],
      activeMissionId: null,
      dataVersion: 0,          // bumped when stored data is removed, so tabs refetch
      loading: false,
      error: null,

      activeMission: () => get().missions.find((m) => m.id === get().activeMissionId) ?? null,

      fetchMissions: async () => {
        set({ loading: true });
        try {
          const { data } = await missionsApi.list();
          const stillExists = data.some((m) => m.id === get().activeMissionId);
          set({ missions: data, loading: false, error: null, ...(stillExists ? {} : { activeMissionId: null }) });
        } catch (err) {
          set({ loading: false, error: errorMessage(err) });
        }
      },

      setActiveMission: (id) => set({ activeMissionId: id || null }),

      createMission: async (body) => {
        try {
          const mission = await missionsApi.create(body);
          set((s) => ({ missions: [mission, ...s.missions], activeMissionId: mission.id }));
          toast.success(`Mission "${mission.name}" created and selected`);
          return mission;
        } catch (err) {
          toast.error(errorMessage(err));
          throw err;
        }
      },

      /** Rename / edit a mission. */
      updateMission: async (id, body) => {
        try {
          const mission = await missionsApi.update(id, body);
          set((s) => ({ missions: s.missions.map((m) => (m.id === id ? mission : m)) }));
          toast.success(`Mission renamed to "${mission.name}"`);
          return mission;
        } catch (err) {
          toast.error(errorMessage(err));
          throw err;
        }
      },

      /** Delete a mission with all its scans, detections and stored files (backend cascades). */
      deleteMission: async (id) => {
        const mission = get().missions.find((m) => m.id === id);
        try {
          await missionsApi.remove(id);
          set((s) => ({
            missions: s.missions.filter((m) => m.id !== id),
            activeMissionId: s.activeMissionId === id ? null : s.activeMissionId,
            dataVersion: s.dataVersion + 1,
          }));
          toast.success(`Deleted mission "${mission?.name ?? id}" with ${mission?.stats?.scans ?? 0} scans and ${mission?.stats?.detections ?? 0} detections`);
        } catch (err) {
          toast.error(errorMessage(err));
          throw err;
        }
      },
    }),
    { name: 'sonarscan-mission', partialize: (s) => ({ activeMissionId: s.activeMissionId }) },
  ),
);
