import axios from 'axios';

export const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

/** Normalised error thrown by every API call: { status, code, message, details }. */
export class ApiError extends Error {
  constructor({ status = 0, code = 'NETWORK_ERROR', message = 'Network error', details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const api = axios.create({
  baseURL: API_BASE_URL,
  // Analyses of long sonar strips run synchronously on the backend and can take minutes on CPU.
  timeout: 6 * 60 * 1000,
});

async function readErrorBody(data) {
  // Blob responses (downloads, images) carry the JSON error as a Blob.
  if (data instanceof Blob) {
    try {
      return JSON.parse(await data.text());
    } catch {
      return undefined;
    }
  }
  return data;
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (axios.isCancel(error)) throw error;
    if (!error.response) {
      const timeout = error.code === 'ECONNABORTED';
      throw new ApiError({
        code: timeout ? 'TIMEOUT' : 'NETWORK_ERROR',
        message: timeout ? 'The server took too long to respond' : 'Cannot reach the SagarNetra server. Is the backend running?',
      });
    }
    const body = await readErrorBody(error.response.data);
    const e = body?.error ?? {};
    throw new ApiError({
      status: error.response.status,
      code: e.code ?? `HTTP_${error.response.status}`,
      message: e.message ?? error.message,
      details: e.details,
    });
  },
);

/** Unwrap the backend envelope { success, data, meta }. */
export const unwrap = (res) => res.data.data;
export const unwrapList = (res) => ({ data: res.data.data, meta: res.data.meta });

/** Human-readable message for toasts, including field-level validation details. */
export function errorMessage(err) {
  if (!(err instanceof ApiError)) return err?.message ?? 'Something went wrong';
  if (Array.isArray(err.details) && err.details.length) {
    return `${err.message}: ${err.details.map((d) => `${d.field} ${d.message}`).join('; ')}`;
  }
  return err.message;
}
