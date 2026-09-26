// lib/dam.js — the metadata model for the Onyx file library.
//
// Assets carry a flexible `metadata` object (stored in files.metadata
// JSONB). Which fields exist is admin-configurable (a settings blob), seeded
// with DEFAULT_METADATA_SCHEMA below. Some facets are AUTO-derived from the file
// itself (type/format/aspect/year) and never stored or edited.
//
// This module is shared by the server (page/api/vision) and the client
// (FilesClient facet rail + per-asset editor) — keep it dependency-free.

import { effectiveKind } from './media.js';
import { STATUS_LABELS } from './review.js';

// Editable, admin-defined fields. `ai: true` marks a field the vision
// auto-tagger may fill. type ∈ text | select | multiselect | date.
export const DEFAULT_METADATA_SCHEMA = {
  fields: [
    { key: 'project', label: 'Project', type: 'multiselect', ai: true, options: [] },
    { key: 'subject', label: 'Subject', type: 'multiselect', ai: true, options: [] },
    { key: 'source', label: 'Source', type: 'select', options: ['Original', 'Commissioned', 'Stock', 'AI-generated', 'Client-supplied'] },
    { key: 'author', label: 'Author / Creator', type: 'text' },
    { key: 'copyright', label: 'Copyright', type: 'text' },
    { key: 'license', label: 'License / Terms', type: 'text' },
    { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Archived'] },
    // Usage-rights expiries. Any date field whose key matches /expir/ is picked
    // up by expiryState(), so adding a channel here is enough to have it
    // flagged in the UI when it lapses.
    { key: 'web_expiration', label: 'Web Expiration', type: 'date', group: 'Usage rights' },
    { key: 'social_expiration', label: 'Social Expiration', type: 'date', group: 'Usage rights' },
    { key: 'print_expiration', label: 'Print Expiration', type: 'date', group: 'Usage rights' },
    { key: 'broadcast_expiration', label: 'Broadcast Expiration', type: 'date', group: 'Usage rights' },
  ],
};

const FIELD_TYPES = new Set(['text', 'select', 'multiselect', 'date']);
const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// Validate/shape a saved schema; fall back to the default when missing/empty.
export function normalizeSchema(raw) {
  const fields = Array.isArray(raw?.fields) ? raw.fields : null;
  if (!fields || !fields.length) return clone(DEFAULT_METADATA_SCHEMA);
  const seen = new Set();
  const out = [];
  for (const f of fields) {
    if (!f || typeof f !== 'object') continue;
    const key = slug(f.key || f.label);
    if (!key || seen.has(key)) continue;
    const type = FIELD_TYPES.has(f.type) ? f.type : 'text';
    seen.add(key);
    out.push({
      key,
      label: String(f.label || key).slice(0, 60),
      type,
      ai: !!f.ai,
      group: f.group ? String(f.group).slice(0, 40) : undefined,
      options: Array.isArray(f.options) ? f.options.map((o) => String(o)).filter(Boolean).slice(0, 200) : undefined,
    });
  }
  return { fields: out.length ? out : clone(DEFAULT_METADATA_SCHEMA.fields) };
}

const clone = (o) => JSON.parse(JSON.stringify(o));

// ── Auto-derived facets (read-only; computed from the file, never stored) ──
export const AUTO_FACETS = [
  { key: 'file_type', label: 'File Type' },
  { key: 'format', label: 'Format' },
  { key: 'aspect_ratio', label: 'Aspect Ratio' },
  { key: 'year', label: 'Year' },
  // Kept on the row by the review routes (files.review_status), so filtering
  // by it costs the grid nothing.
  { key: 'review_status', label: 'Review status' },
];

const KIND_LABEL = { image: 'Image', video: 'Video', audio: 'Audio', doc: 'Document', other: 'Other' };
const COMMON_RATIOS = [[1, 1], [4, 5], [5, 4], [9, 16], [16, 9], [3, 4], [4, 3], [2, 3], [3, 2], [9, 21], [21, 9]];

export function aspectLabel(w, h) {
  if (!w || !h) return null;
  const r = w / h;
  let best = null, bd = Infinity;
  for (const [a, b] of COMMON_RATIOS) { const d = Math.abs(r - a / b); if (d < bd) { bd = d; best = `${a}:${b}`; } }
  return best;
}

function extOf(name = '', mime = '') {
  const m = String(name).split('?')[0].match(/\.([a-z0-9]+)$/i);
  if (m) return m[1].toUpperCase();
  const sub = String(mime).split('/')[1];
  return sub ? sub.split(';')[0].toUpperCase() : null;
}

export function deriveAuto(file) {
  const md = file?.metadata || {};
  const created = file?.createdAt || file?.created_at;
  return {
    file_type: KIND_LABEL[effectiveKind(file)] || 'Other',
    format: extOf(file?.name, file?.mime),
    aspect_ratio: aspectLabel(md.width, md.height),
    year: created ? String(new Date(Number(created) || created).getFullYear()) : null,
    review_status: STATUS_LABELS[file?.reviewStatus] || null,
  };
}

// All facet values a file contributes, keyed by facetKey — used for counting
// and matching. Includes tags (the existing column), schema fields, and auto.
export function fileFacetValues(file, schema) {
  const out = {};
  const md = file?.metadata || {};
  out.tags = Array.isArray(file?.tags) ? file.tags.map(String) : [];
  for (const f of schema.fields) {
    const v = md[f.key];
    if (f.type === 'multiselect') out[f.key] = Array.isArray(v) ? v.map(String).filter(Boolean) : (v ? [String(v)] : []);
    else if (f.type === 'date') out[f.key] = v ? [String(v).slice(0, 10)] : [];
    else out[f.key] = v != null && v !== '' ? [String(v)] : [];
  }
  const auto = deriveAuto(file);
  for (const a of AUTO_FACETS) out[a.key] = auto[a.key] ? [auto[a.key]] : [];
  return out;
}

// The full ordered facet list with distinct values + counts across `files`.
export function buildFacets(files, schema) {
  const defs = [
    { key: 'tags', label: 'Tags', type: 'multiselect' },
    ...schema.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, group: f.group })),
    ...AUTO_FACETS.map((a) => ({ ...a, type: 'auto' })),
  ];
  const counts = {};
  for (const d of defs) counts[d.key] = new Map();
  for (const file of files) {
    const fv = fileFacetValues(file, schema);
    for (const d of defs) for (const val of (fv[d.key] || [])) counts[d.key].set(val, (counts[d.key].get(val) || 0) + 1);
  }
  return defs.map((d) => ({
    ...d,
    values: [...counts[d.key].entries()].map(([value, count]) => ({ value, count })).sort((a, b) => (b.count - a.count) || String(a.value).localeCompare(String(b.value))),
  }));
}

// Does a file pass the active facet selection? AND across facets, OR within one.
// `selected` = { [facetKey]: string[] }.
export function fileMatchesFacets(file, selected, schema) {
  const fv = fileFacetValues(file, schema);
  for (const key of Object.keys(selected)) {
    const want = selected[key];
    if (!want || !want.length) continue;
    const have = fv[key] || [];
    if (!want.some((w) => have.includes(w))) return false;
  }
  return true;
}

// Empty selection helper.
export const hasAnyFacet = (selected) => Object.values(selected || {}).some((a) => a && a.length);

// Coerce/filter a metadata patch to the schema: drop unknown fields (no orphaned
// keys), coerce values to each field's type (multiselect→string[], others→string).
// Used by the metadata API routes so a hand-crafted request can't pollute the
// JSONB with junk keys or wrong-typed values.
//
// An empty value — null, '', or a multiselect with nothing left in it — is an
// explicit CLEAR and comes out as null. updateFile merges the patch (jsonb ||),
// so skipping empties, as this used to, made a value impossible to remove once
// set: the merge kept the old one. A stored null reads as empty everywhere
// (fileFacetValues, the list's cells).
export function validateMetadataPatch(patch, schema) {
  const out = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  const byKey = Object.fromEntries((schema?.fields || []).map((f) => [f.key, f]));
  for (const [key, val] of Object.entries(patch)) {
    // Reserved system keys (set at upload, power the auto facets) pass through.
    if ((key === 'width' || key === 'height') && Number.isFinite(Number(val))) { out[key] = Number(val); continue; }
    const f = byKey[key];
    if (!f) continue;
    if (f.type === 'multiselect') {
      const arr = (val == null ? [] : Array.isArray(val) ? val : [val]).map(String).map((s) => s.trim()).filter(Boolean);
      out[key] = arr.length ? [...new Set(arr)] : null;
    } else {
      const s = val == null ? '' : String(Array.isArray(val) ? val[0] ?? '' : val).trim();
      out[key] = s || null;
    }
  }
  return out;
}

export const METADATA_FIELD_TYPES = [
  { type: 'text', label: 'Text' },
  { type: 'select', label: 'One of a list' },
  { type: 'multiselect', label: 'Several of a list' },
  { type: 'date', label: 'Date' },
];

/**
 * Add a field to a schema. Returns { schema, field } or { error }.
 *
 * The key is derived from the label the same way normalizeSchema derives it,
 * so what is checked for a clash here is exactly what would be stored. A clash
 * with a tag or auto facet key is refused too: the facet rail keys values by
 * field key, and a field called "Format" would silently merge with the
 * derived file format.
 */
export function addMetadataField(schema, { label, type = 'text', options } = {}) {
  const name = String(label || '').trim().slice(0, 60);
  if (!name) return { error: 'Give the field a name.' };
  const key = slug(name);
  if (!key) return { error: 'Use at least one letter or number in the name.' };
  if (!FIELD_TYPES.has(type)) return { error: 'Choose a field type.' };
  const reserved = new Set(['tags', 'width', 'height', ...AUTO_FACETS.map((a) => a.key)]);
  const current = normalizeSchema(schema);
  if (reserved.has(key) || current.fields.some((f) => f.key === key)) {
    return { error: `A field called “${name}” already exists.` };
  }
  const list = (Array.isArray(options) ? options : String(options || '').split(','))
    .map((o) => String(o).trim())
    .filter(Boolean);
  const field = { key, label: name, type };
  if (type === 'select' || type === 'multiselect') field.options = [...new Set(list)];
  const next = normalizeSchema({ fields: [...current.fields, field] });
  return { schema: next, field: next.fields.find((f) => f.key === key) };
}

// ── Usage-rights expiry awareness ──
// Returns 'expired' | 'soon' | null for a file, scanning *_expiration fields.
export function expiryState(file, schema, now = Date.now()) {
  const md = file?.metadata || {};
  const SOON = 30 * 24 * 60 * 60 * 1000;
  let state = null;
  for (const f of schema.fields) {
    if (f.type !== 'date' || !/expir/i.test(f.key)) continue;
    const raw = md[f.key];
    if (!raw) continue;
    const t = new Date(raw).getTime();
    if (!Number.isFinite(t)) continue;
    if (t < now) return 'expired';
    if (t - now < SOON) state = 'soon';
  }
  return state;
}
