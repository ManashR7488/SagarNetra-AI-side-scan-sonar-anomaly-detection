/** Consistent JSON envelope: { success, data, meta? } */
export const ok = (res, data, meta, status = 200) =>
  res.status(status).json(meta === undefined ? { success: true, data } : { success: true, data, meta });

export const created = (res, data) => ok(res, data, undefined, 201);
