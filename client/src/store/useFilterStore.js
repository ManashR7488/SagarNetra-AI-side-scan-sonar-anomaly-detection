import { create } from 'zustand';
import { filterApi } from '../api';
import { errorMessage } from '../config/axios';
import { SAMPLE_SCANS } from '../data/sonarData';
import { toast } from './useToastStore';

export const DEFAULT_FILTER_PARAMS = {
  denoise: 'lee',
  denoiseStrength: 60,
  clahe: false,
  claheStrength: 40,
  repairDropouts: true,
  shadowGamma: 1,
};

/** Noise Filtration tab: source image, filter parameters and the last server-side result. */
export const useFilterStore = create((set, get) => ({
  source: { kind: 'sample', sample: SAMPLE_SCANS[0] },   // or { kind: 'file', file, url }
  params: DEFAULT_FILTER_PARAMS,
  result: null,        // response of POST /api/filter
  loading: false,

  setParams: (patch) => set((s) => ({ params: { ...s.params, ...patch } })),
  resetParams: () => set({ params: DEFAULT_FILTER_PARAMS }),

  setSample: (sampleId) => {
    const sample = SAMPLE_SCANS.find((s) => s.id === sampleId);
    if (sample) set({ source: { kind: 'sample', sample }, result: null });
  },

  setFile: (file) => {
    const old = get().source;
    if (old.kind === 'file' && old.url) URL.revokeObjectURL(old.url);
    set({ source: { kind: 'file', file, url: /\.xtf$/i.test(file.name) ? null : URL.createObjectURL(file) }, result: null });
  },

  run: async () => {
    const { source, params } = get();
    set({ loading: true });
    try {
      const file = source.kind === 'file'
        ? source.file
        : new File([await fetch(source.sample.image).then((r) => r.blob())], source.sample.filename);
      const result = await filterApi.preview({
        file,
        ...params,
        denoiseStrength: params.denoise === 'none' ? undefined : params.denoiseStrength,
        claheStrength: params.clahe ? params.claheStrength : undefined,
      });
      set({ result, loading: false });
    } catch (err) {
      set({ loading: false });
      toast.error(errorMessage(err));
    }
  },
}));
