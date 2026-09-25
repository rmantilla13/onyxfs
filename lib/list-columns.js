// lib/list-columns.js — the list view's columns: which exist, which are shown,
// and the server sort keys behind the sortable ones (SORTS in lib/file-query.js).
//
// The server sorts, not the browser: the list is paged and virtualized, so the
// rows on hand are only the first page or so of the folder, and sorting those
// locally would reorder a sample rather than the listing. That is why only the
// columns backed by a real sort key have a clickable header; a metadata column
// shows and edits values but cannot order the listing.

export const LIST_COLUMNS = [
  // `first` is the direction a column opens in: names and types read A→Z,
  // sizes and dates are wanted biggest/newest first.
  { key: 'name', label: 'Name', asc: 'name', desc: 'name_desc', first: 'asc' },
  { key: 'size', label: 'Size', asc: 'small', desc: 'size', first: 'desc' },
  { key: 'type', label: 'Type', asc: 'type', desc: 'type_desc', first: 'asc' },
  { key: 'modified', label: 'Modified', asc: 'modified_old', desc: 'modified', first: 'desc' },
  { key: 'added', label: 'Added', asc: 'old', desc: 'new', first: 'desc' },
];

/** The column and direction a sort key shows as, or null. */
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

// ── Choosable columns ────────────────────────────────────────────────────────
// Name is always there and always first; everything after it is the viewer's
// choice, in the viewer's order. `min` and `max` are the column's track in
// pixels: it grows to `max` when there is room and gives way down to `min`
// before the name does, so adding columns narrows them rather than pushing
// the list off the side of the page.
//
// `edit` names the editor an editable column gets. Tags and the schema's
// metadata fields are editable; everything derived from the file is not.

const FILE_COLUMNS = [
  { key: 'size', label: 'Size', min: 64, max: 92 },
  { key: 'type', label: 'Type', min: 64, max: 110 },
  { key: 'modified', label: 'Modified', min: 96, max: 190 },
  { key: 'added', label: 'Added', min: 96, max: 190 },
  { key: 'added_by', label: 'Added by', min: 96, max: 200 },
  { key: 'dimensions', label: 'Dimensions', min: 88, max: 120 },
  { key: 'aspect_ratio', label: 'Aspect ratio', min: 64, max: 100 },
  { key: 'folder', label: 'Folder', min: 96, max: 180 },
  { key: 'tags', label: 'Tags', min: 120, max: 220, edit: 'tags' },
];

const METADATA_WIDTH = {
  text: { min: 110, max: 200 },
  select: { min: 96, max: 150 },
  multiselect: { min: 120, max: 220 },
  date: { min: 110, max: 130 },
};

export const METADATA_PREFIX = 'meta:';
export const DEFAULT_COLUMNS = ['size', 'type', 'modified'];
export const COLUMNS_STORAGE_KEY = 'onyx.files.columns';

/**
 * Every column the viewer may pick, in picker order: facts about the file,
 * then one per metadata field. With `metadata` off (the feature flag), the
 * schema's fields are not offered — tags are, as they are not part of it.
 */
export function availableColumns(schema, { metadata = true } = {}) {
  const sortable = new Map(LIST_COLUMNS.map((c) => [c.key, c]));
  const fileCols = FILE_COLUMNS.map((c) => {
    const s = sortable.get(c.key);
    return { ...c, group: 'File', ...(s ? { asc: s.asc, desc: s.desc, first: s.first } : null) };
  });
  if (!metadata) return fileCols;
  const metaCols = (schema?.fields || []).map((f) => ({
    key: `${METADATA_PREFIX}${f.key}`,
    label: f.label,
    group: 'Metadata',
    field: f,
    edit: f.type,
    ...(METADATA_WIDTH[f.type] || METADATA_WIDTH.text),
  }));
  return [...fileCols, ...metaCols];
}

/**
 * The stored column choice, trusted only as far as it names columns that
 * exist. A field an admin has since removed, or a key from an older build,
 * drops out rather than rendering as an empty column; nothing usable left
 * means the default.
 */
export function parseColumns(raw, available) {
  const known = new Set((available || []).map((c) => c.key));
  let list = null;
  try { list = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { list = null; }
  if (Array.isArray(list)) {
    const keys = [...new Set(list.filter((k) => typeof k === 'string' && known.has(k)))];
    // An empty array is a real choice: just the name.
    if (keys.length || list.length === 0) return keys;
  }
  return DEFAULT_COLUMNS.filter((k) => known.has(k));
}

/** Resolve column keys to their definitions, in order, skipping unknowns. */
export function resolveColumns(keys, available) {
  const byKey = new Map((available || []).map((c) => [c.key, c]));
  return (keys || []).map((k) => byKey.get(k)).filter(Boolean);
}

/**
 * The CSS grid tracks for a row: thumbnail, name, the chosen columns, and a
 * trailing slot for the header's column picker. Name never drops below a
 * readable width, and takes whatever the columns leave.
 */
export function columnTemplate(columns, { thumb = 44, nameMin = 160, trailing = 28 } = {}) {
  const tracks = (columns || []).map((c) => `minmax(${c.min}px, ${c.max}px)`);
  return [`${thumb}px`, `minmax(${nameMin}px, 1fr)`, ...tracks, `${trailing}px`].join(' ');
}

/** The narrowest a row with these columns can be: every track at its minimum. */
export function columnMinWidth(columns, { thumb = 44, nameMin = 160, trailing = 28, gap = 12, pad = 16 } = {}) {
  const list = columns || [];
  const tracks = 3 + list.length;
  return thumb + nameMin + trailing + list.reduce((n, c) => n + c.min, 0) + gap * (tracks - 1) + pad;
}

/**
 * As many of the chosen columns as fit in `width`, in the chosen order. A row
 * wider than the page scrolls the whole page sideways; a scrolling list would
 * clip the editors and the column picker that open over it. So the columns at
 * the end of the viewer's order wait for room, and the header says how many.
 */
export function fitColumns(columns, width, opts) {
  const list = columns || [];
  if (!width) return list;
  let n = list.length;
  while (n > 0 && columnMinWidth(list.slice(0, n), opts) > width) n -= 1;
  return list.slice(0, n);
}

/** Move `key` one place toward the start (-1) or the end (+1). */
export function moveColumn(keys, key, delta) {
  const i = keys.indexOf(key);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= keys.length) return keys;
  const next = [...keys];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
