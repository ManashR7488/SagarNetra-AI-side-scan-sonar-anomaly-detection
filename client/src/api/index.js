import axios from 'axios';
import { API_BASE_URL, ApiError, api, unwrap, unwrapList } from '../config/axios';

// Serverless hosts (Vercel) reject request bodies over 4.5 MB, so bigger sonar files (e.g. XTF logs) are
// uploaded straight from the browser to Cloudinary and the API receives only a reference to them.
const DIRECT_UPLOAD_BYTES = 4 * 1024 * 1024;

async function uploadDirect(file, { onUploadProgress, signal } = {}) {
  const sig = await api.post('/uploads/sign', { filename: file.name }, { signal }).then(unwrap);
  const form = new FormData();
  for (const [k, v] of Object.entries(sig.fields)) form.append(k, v);
  form.append('file', file);
  try {
    const { data } = await axios.post(sig.uploadUrl, form, { onUploadProgress, signal });
    return { publicId: data.public_id, resourceType: sig.resourceType, filename: file.name };
  } catch (err) {
    if (axios.isCancel(err)) throw err;
    throw new ApiError({ status: err.response?.status ?? 0, code: 'UPLOAD_FAILED', message: `Upload to cloud storage failed: ${err.response?.data?.error?.message ?? err.message}` });
  }
}

/** Replace a large `file` with a `fileRef` after a direct upload; unchanged when the backend stores files locally. */
async function withLargeFile(fields, opts) {
  const { file } = fields;
  if (!(file instanceof Blob) || file.size <= DIRECT_UPLOAD_BYTES) return fields;
  try {
    const ref = await uploadDirect(file, opts);
    const rest = { ...fields };
    delete rest.file;
    return { ...rest, fileRef: JSON.stringify(ref) };
  } catch (err) {
    if (err?.code === 'DIRECT_UPLOAD_DISABLED') return fields; // local storage: no platform body limit
    throw err;
  }
}

/** Build FormData from an object, skipping empty values; arrays become comma lists. */
function toFormData(fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    if (value instanceof Blob) form.append(key, value, value.name);
    else form.append(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  return form;
}

/** Drop empty query params (and join arrays) so the backend validators only see real filters. */
function cleanParams(params = {}) {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]),
  );
}

export const systemApi = {
  health: () => api.get('/health', { validateStatus: (s) => s === 200 || s === 503 }).then((r) => r.data.data),
  models: () => api.get('/models').then(unwrap),
};

export const missionsApi = {
  list: (params) => api.get('/missions', { params: cleanParams({ limit: 100, ...params }) }).then(unwrapList),
  get: (id) => api.get(`/missions/${id}`).then(unwrap),
  create: (body) => api.post('/missions', body).then(unwrap),
  update: (id, body) => api.patch(`/missions/${id}`, body).then(unwrap),
  remove: (id) => api.delete(`/missions/${id}`),
};

export const scansApi = {
  list: (params) => api.get('/scans', { params: cleanParams({ limit: 100, ...params }) }).then(unwrapList),
  get: (id, params) => api.get(`/scans/${id}`, { params: cleanParams(params) }).then(unwrap),
  /** Upload + analyse. `fields` = { file, metadata?, missionId?, name?, ...options, ...georef } */
  create: async (fields, { onUploadProgress, signal } = {}) => {
    const body = await withLargeFile(fields, { onUploadProgress, signal });
    return api.post('/scans', toFormData(body), { onUploadProgress: body.fileRef ? undefined : onUploadProgress, signal }).then(unwrap);
  },
  reanalyze: (id, options) => api.post(`/scans/${id}/reanalyze`, options).then(unwrap),
  /** Send a draft reviewed in the Noise Filtration tab to AI Detection (applies the review threshold). */
  publish: (id, body) => api.post(`/scans/${id}/publish`, body).then(unwrap),
  remove: (id) => api.delete(`/scans/${id}`),
};

export const detectionsApi = {
  list: (params) => api.get('/detections', { params: cleanParams(params) }).then(unwrapList),
  geojson: (params) => api.get('/detections/geojson', { params: cleanParams(params) }).then((r) => r.data),
  stats: (params) => api.get('/detections/stats', { params: cleanParams(params) }).then(unwrap),
  get: (id) => api.get(`/detections/${id}`).then(unwrap),
  review: (id, body) => api.patch(`/detections/${id}/review`, body).then(unwrap),
};

export const noiseApi = {
  /**
   * Stage 1: clean the signal step by step and report the noise.
   * fields = { file, profile: 'ai'|'analyst', auto, params (object), swathWidthM, previewSide }
   * output 'jpeg' returns one step image at full resolution (Blob).
   */
  clean: async (fields, { signal, output = 'json', step } = {}) => {
    const body = await withLargeFile({ ...fields, params: fields.params ? JSON.stringify(fields.params) : undefined }, { signal });
    const res = await api.post('/filter/clean', toFormData(body), {
      params: cleanParams({ output, step }), signal, responseType: output === 'jpeg' ? 'blob' : 'json',
    });
    return output === 'jpeg' ? res.data : unwrap(res);
  },
  /** Stage 3: one disturbance at increasing levels, detection raw / auto-cleaned / fully cleaned. */
  stress: async (fields, { signal } = {}) => api.post('/filter/stress', toFormData(await withLargeFile(fields, { signal })), { signal }).then(unwrap),
};

/** Absolute URL of a backend download (reports, CSV exports). */
export function downloadUrl(path, params) {
  const qs = new URLSearchParams(cleanParams(params)).toString();
  return `${API_BASE_URL}${path}${qs ? `?${qs}` : ''}`;
}
