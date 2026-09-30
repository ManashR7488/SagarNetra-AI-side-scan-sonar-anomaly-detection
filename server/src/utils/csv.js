const escape = (value) => {
  if (value === null || value === undefined) return '';
  const s = Array.isArray(value) ? value.join(';') : value instanceof Date ? value.toISOString() : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** columns: [{ header, value: (row) => any }] */
export function toCsv(rows, columns) {
  const lines = [columns.map((c) => escape(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => escape(c.value(row))).join(','));
  return `${lines.join('\n')}\n`;
}
