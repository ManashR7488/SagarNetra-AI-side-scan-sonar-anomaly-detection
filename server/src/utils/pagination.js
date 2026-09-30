export const MAX_LIMIT = 200;

/** Normalises ?page & ?limit into skip/limit for Mongo queries. */
export function getPagination(query, defaultLimit = 20) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

export const paginationMeta = ({ page, limit }, total) => ({ page, limit, total, pages: Math.ceil(total / limit) });
