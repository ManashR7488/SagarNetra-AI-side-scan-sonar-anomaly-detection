/** Operational error with an HTTP status; anything else reaching the error handler is a 500. */
export class ApiError extends Error {
  constructor(status, message, { code, details } = {}) {
    super(message);
    this.status = status;
    this.code = code ?? ApiError.codeFor(status);
    this.details = details;
  }

  static codeFor(status) {
    return {
      400: 'BAD_REQUEST', 404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE',
      422: 'UNPROCESSABLE_ENTITY', 502: 'BAD_GATEWAY', 503: 'SERVICE_UNAVAILABLE', 504: 'GATEWAY_TIMEOUT',
    }[status] ?? 'ERROR';
  }

  static badRequest(message, details) { return new ApiError(400, message, { details }); }
  static notFound(what = 'Resource') { return new ApiError(404, `${what} not found`); }
}
