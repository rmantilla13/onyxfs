// lib/views.js — views: which files a listing shows, and how it shows them.
//
// A view is a name, the filters that pick the files (kinds, metadata facet
// values, tags, a text search), a sort, and display settings: the layout
// (grid, list, tile or column), the metadata fields shown on cards and list
// rows, how thumbnails fill their box, the card size, and whether the
// listing flattens every folder beneath the open one into one list.
//
// Two sorts of view. The built-ins below — All files, Recent and one per
// kind of file — are the same for everyone; someone who changes one's
// display or sort keeps the change in their browser (`local`). Saved views
// are a person's own, stored on the server (saved_views, lib/db.js) so the
// web and the Mac app share them, optionally scoped to one drive.
//
// Pure and dependency-light, so the files page, its server render, the
// /api/views routes and the tests all read one definition. Two strictnesses:
// `normalize*` reads what is stored or kept in a browser and quietly drops
// what it does not recognise (a field an admin has since removed, a key from
// an older build); `validateViewInput` is what the API accepts, and says
// what is wrong instead.

import { LIST_COLUMNS, columnOf } from './list-columns.js';

export const LAYOUTS = ['grid', 'list', 'tile', 'column'];
export const THUMB_MODES = ['fill', 'fit'];
export const CARD_SIZES = ['s', 'm', 'l'];

// The kinds a listing can be filtered to on the server (files.kind).
export const KIND_KEYS = ['image', 'video', 'audio', 'doc', 'other'];

// Must stay in step with SORTS in lib/file-query.js (a test holds them to
// it). Kept here rather than imported: that module is the listing's SQL, and
// the files page is a client bundle.
export const SORT_KEYS = ['new', 'old', 'name', 'name_desc', 'size', 'small', 'type', 'type_desc', 'modified', 'modified_old'];

// What a person may keep. Generous for any real use, small enough that a
// hand-made request cannot make a row a megabyte.
export const LIMITS = {
  views: 100,
  name: 60,
  fields: 40,
  facets: 30,
  facetValues: 100,
  value: 200,
  tags: 100,
  tag: 100,
  query: 200,
};

// A field is a list column's key (lib/list-columns.js): a fact about the
// file, tags, or one of the workspace's metadata fields. Whether a metadata
// field still exists is decided where the schema is known, when the view is
// drawn; here only the shape is checked.
const FILE_FIELDS = new Set(['size', 'type', 'modified', 'added', 'duration', 'dimensions', 'aspect_ratio', 'added_by', 'folder', 'tags']);
const META_FIELD = /^meta:[a-z0-9_]{1,60}$/;
export const isFieldKey = (k) => typeof k === 'string' && (FILE_FIELDS.has(k) || META_FIELD.test(k));
const FACET_KEY = /^[a-z0-9_]{1,60}$/;

export const DEFAULT_DISPLAY = Object.freeze({
  layout: 'grid',
  fields: Object.freeze(['size', 'type', 'modified']),
  thumb: 'fill',
  size: 'm',
  flatten: false,
});

/**
 * The predetermined views, in the order the Select view menu lists them.
 *
 * The kinds flatten by default: a kind has always been a search through
 * everything beneath the open folder ("every video in this drive"), and one
 * level at a time would find next to nothing at the top of a drive. Turning
 * Flatten off in the Display popover goes back to folder by folder.
 */
export const BUILTIN_VIEWS = Object.freeze([
  { id: 'all', name: 'All files', icon: 'files', filters: {}, sort: 'new', display: { layout: 'grid', fields: ['size', 'type', 'modified'] } },
  { id: 'recent', name: 'Recent', icon: 'clock', filters: {}, sort: 'modified', display: { layout: 'grid', fields: ['modified', 'folder'], flatten: true } },
  { id: 'images', name: 'Images', icon: 'image', filters: { kinds: ['image'] }, sort: 'new', display: { layout: 'tile', fields: ['dimensions'], flatten: true } },
  { id: 'video', name: 'Video', icon: 'film', filters: { kinds: ['video'] }, sort: 'new', display: { layout: 'grid', fields: ['duration', 'dimensions', 'size'], flatten: true } },
  { id: 'audio', name: 'Audio', icon: 'audio-lines', filters: { kinds: ['audio'] }, sort: 'new', display: { layout: 'list', fields: ['duration', 'size', 'modified'], flatten: true } },
  { id: 'documents', name: 'Documents', icon: 'file-text', filters: { kinds: ['doc'] }, sort: 'new', display: { layout: 'list', fields: ['type', 'size', 'modified'], flatten: true } },
  { id: 'other', name: 'Other', icon: 'file', filters: { kinds: ['other'] }, sort: 'new', display: { layout: 'list', fields: ['size', 'type', 'modified'], flatten: true } },
].map((v) => Object.freeze({ ...v, builtin: true })));

export const DEFAULT_VIEW_ID = 'all';
const BUILTIN = new Map(BUILTIN_VIEWS.map((v) => [v.id, v]));
export const isBuiltinView = (id) => BUILTIN.has(id);

// ── Reading what is stored ───────────────────────────────────────────────────

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const uniq = (list) => [...new Set(list)];

/** Display settings, anything unrecognised replaced by `fallback`'s. */
export function normalizeDisplay(raw, fallback = DEFAULT_DISPLAY) {
  const d = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const base = fallback || DEFAULT_DISPLAY;
  return {
    layout: LAYOUTS.includes(d.layout) ? d.layout : base.layout,
    fields: Array.isArray(d.fields) ? uniq(d.fields.filter(isFieldKey)).slice(0, LIMITS.fields) : [...(base.fields || [])],
    thumb: THUMB_MODES.includes(d.thumb) ? d.thumb : base.thumb || 'fill',
    size: CARD_SIZES.includes(d.size) ? d.size : base.size || 'm',
    flatten: typeof d.flatten === 'boolean' ? d.flatten : !!base.flatten,
  };
}

/** { [facetKey]: values } with the empty ones gone, keys sorted — so equal filters compare equal. */
function normalizeFacets(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of Object.keys(raw).sort().slice(0, LIMITS.facets * 2)) {
    if (!FACET_KEY.test(key) || key === 'tags') continue;
    const values = Array.isArray(raw[key]) ? uniq(raw[key].map((v) => str(v, LIMITS.value)).filter(Boolean)).slice(0, LIMITS.facetValues) : [];
    if (values.length) out[key] = values;
    if (Object.keys(out).length >= LIMITS.facets) break;
  }
  return out;
}

/** A view's filters: { kinds, facets, tags, q }, each always present. */
export function normalizeFilters(raw) {
  const f = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    kinds: Array.isArray(f.kinds) ? KIND_KEYS.filter((k) => f.kinds.includes(k)) : [],
    facets: normalizeFacets(f.facets),
    tags: Array.isArray(f.tags) ? uniq(f.tags.map((t) => str(t, LIMITS.tag).toLowerCase()).filter(Boolean)).slice(0, LIMITS.tags) : [],
    q: str(f.q, LIMITS.query),
  };
}

export const normalizeSort = (sort, fallback = 'new') => (SORT_KEYS.includes(sort) ? sort : fallback);

// ── What the API accepts ─────────────────────────────────────────────────────

const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const bad = (error) => ({ error });

function checkFilters(f) {
  if (!plain(f)) return bad('filters must be an object.');
  const known = new Set(['kinds', 'facets', 'tags', 'q']);
  const extra = Object.keys(f).find((k) => !known.has(k));
  if (extra) return bad(`filters.${extra} is not a filter. Use kinds, facets, tags and q.`);
  if (f.kinds !== undefined) {
    if (!Array.isArray(f.kinds) || f.kinds.some((k) => !KIND_KEYS.includes(k))) return bad(`filters.kinds must be a list of: ${KIND_KEYS.join(', ')}.`);
  }
  if (f.facets !== undefined) {
    if (!plain(f.facets)) return bad('filters.facets must be an object of field keys to lists of values.');
    const keys = Object.keys(f.facets);
    if (keys.length > LIMITS.facets) return bad(`A view can filter on at most ${LIMITS.facets} fields.`);
    for (const k of keys) {
      if (!FACET_KEY.test(k)) return bad(`"${String(k).slice(0, 40)}" is not a field key.`);
      if (k === 'tags') return bad('Tags go in filters.tags, not filters.facets.');
      const values = f.facets[k];
      if (!Array.isArray(values) || values.some((v) => typeof v !== 'string')) return bad(`filters.facets.${k} must be a list of strings.`);
      if (values.length > LIMITS.facetValues) return bad(`filters.facets.${k} has more than ${LIMITS.facetValues} values.`);
      if (values.some((v) => v.length > LIMITS.value)) return bad(`A value in filters.facets.${k} is longer than ${LIMITS.value} characters.`);
    }
  }
  if (f.tags !== undefined) {
    if (!Array.isArray(f.tags) || f.tags.some((t) => typeof t !== 'string')) return bad('filters.tags must be a list of strings.');
    if (f.tags.length > LIMITS.tags) return bad(`A view can filter on at most ${LIMITS.tags} tags.`);
    if (f.tags.some((t) => t.length > LIMITS.tag)) return bad(`A tag is longer than ${LIMITS.tag} characters.`);
  }
  if (f.q !== undefined && f.q !== null) {
    if (typeof f.q !== 'string') return bad('filters.q must be a string.');
    if (f.q.length > LIMITS.query) return bad(`The search is longer than ${LIMITS.query} characters.`);
  }
  return { value: normalizeFilters(f) };
}

function checkDisplay(d) {
  if (!plain(d)) return bad('display must be an object.');
  const known = new Set(['layout', 'fields', 'thumb', 'size', 'flatten']);
  const extra = Object.keys(d).find((k) => !known.has(k));
  if (extra) return bad(`display.${extra} is not a display setting.`);
  if (d.layout !== undefined && !LAYOUTS.includes(d.layout)) return bad(`display.layout must be one of: ${LAYOUTS.join(', ')}.`);
  if (d.thumb !== undefined && !THUMB_MODES.includes(d.thumb)) return bad(`display.thumb must be one of: ${THUMB_MODES.join(', ')}.`);
  if (d.size !== undefined && !CARD_SIZES.includes(d.size)) return bad(`display.size must be one of: ${CARD_SIZES.join(', ')}.`);
  if (d.flatten !== undefined && typeof d.flatten !== 'boolean') return bad('display.flatten must be true or false.');
  if (d.fields !== undefined) {
    if (!Array.isArray(d.fields)) return bad('display.fields must be a list.');
    if (d.fields.length > LIMITS.fields) return bad(`A view can show at most ${LIMITS.fields} fields.`);
    const wrong = d.fields.find((k) => !isFieldKey(k));
    if (wrong !== undefined) return bad(`"${String(wrong).slice(0, 40)}" is not a field a view can show.`);
  }
  return { value: normalizeDisplay(d) };
}

/**
 * A view as a request describes it → { value } or { error }. With `partial`
 * (PATCH) only what is present is checked and returned; otherwise a name is
 * required and the rest defaults. Unknown top-level keys are refused, so a
 * typo does not look like a save that worked.
 */
export function validateViewInput(body, { partial = false } = {}) {
  if (!plain(body)) return bad('Send the view as a JSON object.');
  const known = new Set(['name', 'driveId', 'filters', 'sort', 'display']);
  const extra = Object.keys(body).find((k) => !known.has(k));
  if (extra) return bad(`"${String(extra).slice(0, 40)}" is not part of a view.`);
  const value = {};

  if (body.name !== undefined || !partial) {
    if (typeof body.name !== 'string' || !body.name.trim()) return bad('Give the view a name.');
    const name = body.name.trim().replace(/\s+/g, ' ');
    if (name.length > LIMITS.name) return bad(`Keep the name to ${LIMITS.name} characters.`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(name)) return bad('The name has a character it cannot use.');
    value.name = name;
  }
  if (body.driveId !== undefined) {
    if (body.driveId !== null && (typeof body.driveId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.driveId))) {
      return bad('driveId must be a drive id, or null for everywhere.');
    }
    value.driveId = body.driveId || null;
  } else if (!partial) {
    value.driveId = null;
  }
  if (body.filters !== undefined) {
    const f = checkFilters(body.filters);
    if (f.error) return f;
    value.filters = f.value;
  } else if (!partial) {
    value.filters = normalizeFilters({});
  }
  if (body.sort !== undefined) {
    if (!SORT_KEYS.includes(body.sort)) return bad(`sort must be one of: ${SORT_KEYS.join(', ')}.`);
    value.sort = body.sort;
  } else if (!partial) {
    value.sort = 'new';
  }
  if (body.display !== undefined) {
    const d = checkDisplay(body.display);
    if (d.error) return d;
    value.display = d.value;
  } else if (!partial) {
    value.display = normalizeDisplay({});
  }
  return { value };
}

/** Case- and space-insensitive, as a person reads two names. */
export const sameName = (a, b) => String(a || '').trim().replace(/\s+/g, ' ').toLowerCase()
  === String(b || '').trim().replace(/\s+/g, ' ').toLowerCase();

// ── Which views apply where ─────────────────────────────────────────────────

/**
 * Saved views whose drive the viewer can still open: `drives` is their list
 * (listFilespacesForSpace). A view scoped to a drive they were taken off —
 * or one since deleted — is not returned, rather than returned and broken.
 */
export function visibleViews(views, drives = []) {
  const ids = new Set((drives || []).map((d) => d.id));
  return (views || []).filter((v) => !v.driveId || ids.has(v.driveId));
}

/** The saved views to offer on a page: everywhere-views, and those for the drive on screen. */
export function viewsForDrive(views, driveId = '') {
  return (views || []).filter((v) => !v.driveId || v.driveId === (driveId || null));
}

/**
 * The view as it applies now, or null for an id that is neither a built-in
 * nor one of `custom`. A built-in is its defaults with this browser's
 * changes over them (`local`, parseLocalViews); `legacy` is the grid/list
 * choice and list columns kept before views existed, which All files starts
 * from until it has changes of its own.
 */
export function resolveView(id, { custom = [], local = {}, legacy = null } = {}) {
  const b = BUILTIN.get(id);
  if (b) {
    const own = local?.[id];
    const over = own || (id === DEFAULT_VIEW_ID && legacy) || {};
    const defaults = normalizeDisplay(b.display);
    return {
      id: b.id,
      name: b.name,
      icon: b.icon,
      builtin: true,
      driveId: null,
      filters: normalizeFilters(b.filters),
      sort: normalizeSort(over.sort, b.sort),
      display: normalizeDisplay(over.display ? { ...defaults, ...over.display } : defaults, defaults),
      defaults: { sort: b.sort, display: defaults },
    };
  }
  const c = (custom || []).find((v) => v && v.id === id);
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    icon: 'bookmark',
    builtin: false,
    driveId: c.driveId || null,
    filters: normalizeFilters(c.filters),
    sort: normalizeSort(c.sort),
    display: normalizeDisplay(c.display),
  };
}

// ── The page's state, and back ──────────────────────────────────────────────

/**
 * What the files page holds while a view is on screen. The filter panel
 * keeps tags among the facets (they are one of its groups), so they are
 * folded in here and taken out again by `viewSettings`.
 */
export function stateFromView(view) {
  const f = normalizeFilters(view?.filters);
  return {
    kinds: f.kinds,
    facets: f.tags.length ? { ...f.facets, tags: f.tags } : f.facets,
    query: f.q,
    sort: normalizeSort(view?.sort),
    display: normalizeDisplay(view?.display),
  };
}

/** The page's state as a view's settings — what "Save current view" stores. */
export function viewSettings({ kinds = [], facets = {}, query = '', sort = 'new', display } = {}) {
  const { tags = [], ...rest } = facets || {};
  return {
    filters: normalizeFilters({ kinds, facets: rest, tags, q: query }),
    sort: normalizeSort(sort),
    display: normalizeDisplay(display),
  };
}

const canonical = (s) => JSON.stringify([s.filters, s.sort, s.display]);

/** Whether two sets of settings would show the same thing: a saved view with unsaved changes is one that differs. */
export function sameSettings(a, b) {
  return canonical(viewSettings(stateFromView(a))) === canonical(viewSettings(stateFromView(b)));
}

// ── A built-in's changes, kept in the browser ───────────────────────────────

export const LOCAL_VIEWS_KEY = 'onyx.files.views';

/**
 * { [builtinId]: { sort?, display? } } from what localStorage (or its cookie
 * copy, for the server render) holds. Only built-ins, only settings that
 * parse; anything else is dropped.
 */
export function parseLocalViews(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { obj = null; }
  }
  const out = {};
  if (!plain(obj)) return out;
  for (const [id, v] of Object.entries(obj)) {
    if (!BUILTIN.has(id) || !plain(v)) continue;
    const entry = {};
    if (SORT_KEYS.includes(v.sort)) entry.sort = v.sort;
    if (plain(v.display)) entry.display = normalizeDisplay(v.display, normalizeDisplay(BUILTIN.get(id).display));
    if (Object.keys(entry).length) out[id] = entry;
  }
  return out;
}

/** `local` with `id`'s sort and display set — or dropped when they are the built-in's own again. */
export function withLocalView(local, id, { sort, display }) {
  const b = BUILTIN.get(id);
  if (!b) return local || {};
  const next = { ...(local || {}) };
  const defaults = normalizeDisplay(b.display);
  const d = normalizeDisplay(display, defaults);
  const s = normalizeSort(sort, b.sort);
  if (s === b.sort && JSON.stringify(d) === JSON.stringify(defaults)) delete next[id];
  else next[id] = { sort: s, display: d };
  return next;
}

/** The grid/list choice and list columns from before views, as All files' starting point. */
export function legacyView({ layout, fields } = {}) {
  const display = {};
  if (layout === 'list' || layout === 'grid') display.layout = layout;
  if (Array.isArray(fields)) display.fields = fields.filter(isFieldKey);
  return Object.keys(display).length ? { display } : null;
}

// ── The listing a view asks for ─────────────────────────────────────────────

/**
 * Whether the listing looks through every folder beneath the open one:
 * flattened, or searching — a search that stopped at one level would find
 * nothing. Otherwise a folder lists what is in it, like a disk.
 */
export const isRecursive = ({ flat = false, query = '' } = {}) => !!flat || !!String(query || '').trim();

/**
 * listFilesForUser's options for a listing — the server render and the
 * browser's request build from this one function (the browser as query
 * parameters, `listingParams`), so the page renders exactly what the
 * client would have asked for.
 */
export function listingOpts({ folder = '', query = '', kinds = [], sort = 'new', flat = false } = {}) {
  const q = String(query || '').trim();
  const opts = isRecursive({ flat, query: q }) ? { folderPrefix: folder || '' } : { folder: folder || '' };
  if (q) opts.q = q;
  if (kinds?.length) opts.kind = [...kinds];
  opts.sort = normalizeSort(sort);
  return opts;
}

/** The same, as GET /api/files query parameters. */
export function listingParams(args = {}, { filespaceId = '', cursor = null, limit = null } = {}) {
  const o = listingOpts(args);
  const p = new URLSearchParams();
  if (o.folderPrefix !== undefined) { if (o.folderPrefix) p.set('folderPrefix', o.folderPrefix); } else p.set('folder', o.folder);
  if (o.q) p.set('q', o.q);
  if (o.kind) p.set('kind', o.kind.join(','));
  p.set('sort', o.sort);
  if (filespaceId) p.set('filespace', filespaceId);
  if (cursor) p.set('cursor', cursor);
  if (limit) p.set('limit', String(limit));
  p.set('folders', '0');
  return p;
}

// ── Sorting, as the Sort menu offers it ─────────────────────────────────────

const SORT_WORDS = {
  modified: { label: 'Date modified', ascLabel: 'Oldest first', descLabel: 'Newest first' },
  added: { label: 'Date created', ascLabel: 'Oldest first', descLabel: 'Newest first' },
  name: { label: 'Name', ascLabel: 'A to Z', descLabel: 'Z to A' },
  size: { label: 'Size', ascLabel: 'Smallest first', descLabel: 'Largest first' },
  type: { label: 'Type', ascLabel: 'A to Z', descLabel: 'Z to A' },
};

/** The fields the listing can be ordered by, with the words for each direction. */
export const SORT_FIELDS = ['modified', 'added', 'name', 'size', 'type'].map((key) => {
  const c = LIST_COLUMNS.find((x) => x.key === key);
  return { key, asc: c.asc, desc: c.desc, first: c.first, ...SORT_WORDS[key] };
});

/** 'size' → { field: 'size', dir: 'desc' }. Unknown keys read as the default, newest created first. */
export function sortParts(sort) {
  const c = columnOf(sort) || columnOf('new');
  return { field: c.key, dir: c.dir };
}

/** The sort key for a field and direction; a field alone opens in its natural direction. */
export function sortFor(field, dir) {
  const f = SORT_FIELDS.find((x) => x.key === field);
  if (!f) return 'new';
  const d = dir === 'asc' || dir === 'desc' ? dir : f.first;
  return d === 'asc' ? f.asc : f.desc;
}

/** "Date modified, newest first" — the Sort button's accessible name. */
export function describeSort(sort) {
  const { field, dir } = sortParts(sort);
  const f = SORT_FIELDS.find((x) => x.key === field);
  return `${f.label}, ${f[`${dir}Label`].toLowerCase()}`;
}

/**
 * A saved view as it goes to the browser: its settings read back through
 * the same normalization as everything else, and nothing about its owner,
 * who is the one asking.
 */
export function toClientView(v) {
  if (!v) return null;
  return {
    id: v.id,
    name: v.name,
    driveId: v.driveId || null,
    filters: normalizeFilters(v.filters),
    sort: normalizeSort(v.sort),
    display: normalizeDisplay(v.display),
    updatedAt: v.updatedAt || null,
  };
}
