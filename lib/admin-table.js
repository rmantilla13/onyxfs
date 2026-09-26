/**
 * Sorting for the admin tables (app/admin/_ui/DataTable.js). Pure, so the
 * order a header click produces is tested without a browser.
 */

const blank = (v) => v == null || v === '' || (typeof v === 'number' && Number.isNaN(v));

/**
 * Compare two cell values the way a person reads them: numbers as numbers,
 * text case-insensitively and with digits in numeric order ("Drive 2" before
 * "Drive 10"). Blanks always sort last, whichever the direction, so an
 * empty column never pushes the rows that have a value off the screen.
 */
export function compareValues(a, b, dir = 'asc') {
  const aBlank = blank(a);
  const bBlank = blank(b);
  if (aBlank || bBlank) return aBlank === bBlank ? 0 : aBlank ? 1 : -1;
  const sign = dir === 'desc' ? -1 : 1;
  if (typeof a === 'number' && typeof b === 'number') return (a - b) * sign;
  if (typeof a === 'boolean' && typeof b === 'boolean') return (Number(a) - Number(b)) * sign;
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true }) * sign;
}

/**
 * The rows in the order `sort` ({ key, dir }) asks for, reading each value
 * through its column's `value` (or row[key]). Stable: rows that compare
 * equal keep the order they came in, which is the server's.
 */
export function sortRows(rows = [], columns = [], sort = null) {
  const list = Array.isArray(rows) ? rows : [];
  if (!sort?.key) return list;
  const col = columns.find((c) => c.key === sort.key);
  if (!col) return list;
  const read = col.value || ((r) => r?.[col.key]);
  return list
    .map((row, i) => ({ row, i, v: read(row) }))
    .sort((x, y) => compareValues(x.v, y.v, sort.dir) || x.i - y.i)
    .map((x) => x.row);
}

/**
 * The sort after clicking a column's header: a new column starts in its
 * natural direction (numbers biggest first, text A to Z); the same column
 * flips.
 */
export function nextSort(current, column) {
  const key = column?.key;
  if (!key) return current || null;
  if (current?.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: column.num ? 'desc' : 'asc' };
}
