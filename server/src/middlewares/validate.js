import { ApiError } from '../utils/ApiError.js';

/**
 * Validate request parts with Zod schemas. Parsed (coerced) values are put on `req.valid.{body,query,params}`
 * because Express 5 makes `req.query` read-only.
 */
export const validate = (schemas) => (req, _res, next) => {
  req.valid = req.valid ?? {};
  for (const part of ['params', 'query', 'body']) {
    if (!schemas[part]) continue;
    const result = schemas[part].safeParse(req[part] ?? {});
    if (!result.success) {
      const details = result.error.issues.map((i) => ({ field: [part, ...i.path].join('.'), message: i.message }));
      return next(ApiError.badRequest(`Invalid ${part}`, details));
    }
    req.valid[part] = result.data;
  }
  next();
};
