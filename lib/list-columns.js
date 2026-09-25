// lib/list-columns.js — the list view's sortable columns, mapped onto the
// server's sort keys (SORTS in lib/file-query.js).
//
// The server sorts, not the browser: the list is paged and virtualized, so the
// rows on hand are only the first page or so of the folder, and sorting those
// locally would reorder a sample rather than the listing.

export const LIST_COLUMNS = [
  // `first` is the direction a column opens in: names and types read A→Z,
  // sizes and dates are wanted biggest/newest first.
  { key: 'name', label: 'Name', asc: 'name', desc: 'name_desc', first: 'asc' },
  { key: 'size', label: 'Size', asc: 'small', desc: 'size', first: 'desc' },
  { key: 'type', label: 'Type', asc: 'type', desc: 'type_desc', first: 'asc' },
  { key: 'modified', label: 'Modified', asc: 'modified_old', desc: 'modified', first: 'desc' },
];

/** The column and direction a sort key shows as, or null (e.g. Newest). */
export function columnOf(sort) {
  for (const c of LIST_COLUMNS) {
    if (c.asc === sort) return { key: c.key, dir: 'asc' };
    if (c.desc === sort) return { key: c.key, dir: 'desc' };
  }
  return null;
}

/** The sort a click on `column`'s header asks for, given the current sort. */
export function nextSortFor(column, sort) {
  const c = LIST_COLUMNS.find((x) => x.key === column);
  if (!c) return sort;
  const cur = columnOf(sort);
  if (cur?.key === column) return cur.dir === 'asc' ? c.desc : c.asc;
  return c.first === 'asc' ? c.asc : c.desc;
}

export const VIEW_STORAGE_KEY = 'onyx.files.view';
export const VIEWS = ['grid', 'list'];

/** A stored view, or the default for anything unrecognised. */
export function parseView(value) {
  return VIEWS.includes(value) ? value : 'grid';
}
