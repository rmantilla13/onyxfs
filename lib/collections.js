// lib/collections.js — collections: the files that meet a set of rules.
//
// A collection is a name, a drive ('' for All Files), and rules joined by
// "all" or "any". A rule reads one field of a file — its kind, its tags, or
// one of the workspace's metadata fields (lib/dam.js) — and asks one thing of
// it: that it is any of some values, none of them, set at all, not set, or
// (a date) before or after a day.
//
// Tags and metadata are inherited from folders: a file meets a tag or
// metadata rule when it carries the value itself, or any folder above it in
// the same drive does (folders.tags / folders.metadata). Tag "Spring 2026" on
// a folder once, and everything in it joins the collections that ask for it.
//
// A collection grants nothing. Its files are a listing like any other — the
// same query, the same access rules (lib/file-query.js collectionClause) —
// so each person sees only the matching files they could already open.
//
// Pure and dependency-free: the routes, the files page and the tests read one
// definition. `normalizeCollection` quietly drops what it does not recognise
// (a rule an older build stored); `validateCollectionInput` is what the API
// accepts, and says what is wrong instead.

export const KINDS = ['image', 'video', 'audio', 'doc', 'other'];
export const MATCHES = ['all', 'any'];
export const OPS = ['any', 'none', 'set', 'unset', 'before', 'after'];
// Which operators take values, and how many.
const NEEDS_VALUES = new Set(['any', 'none']);
const NEEDS_DAY = new Set(['before', 'after']);

export const LIMITS = Object.freeze({ name: 80, rules: 20, values: 50, value: 120, collections: 200 });

const FIELD = /^(kind|tag|meta:[a-z0-9_]{1,60})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const bad = (error) => ({ error });
const uniq = (a) => [...new Set(a)];
const str = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

/** The metadata key a `meta:` field reads, or null for kind and tag. */
export const metaKey = (field) => (String(field || '').startsWith('meta:') ? field.slice(5) : null);

/** Which operators a field takes: kinds are one of a list; dates also compare. */
export function opsFor(field, schema = null) {
  if (field === 'kind') return ['any', 'none'];
  if (field === 'tag') return ['any', 'none', 'set', 'unset'];
  const key = metaKey(field);
  const def = key && schema?.fields?.find((f) => f.key === key);
  return def?.type === 'date' ? ['any', 'none', 'set', 'unset', 'before', 'after'] : ['any', 'none', 'set', 'unset'];
}

/** A rule's values, as stored and compared: trimmed, de-duplicated, tags in lower case. */
function cleanValues(field, values) {
  const list = (Array.isArray(values) ? values : []).map((v) => str(v, LIMITS.value)).filter(Boolean);
  return uniq(field === 'tag' ? list.map((v) => v.toLowerCase()) : list).slice(0, LIMITS.values);
}

// ── Reading what is stored ───────────────────────────────────────────────────

function normalizeRule(raw) {
  if (!plain(raw) || !FIELD.test(String(raw.field || ''))) return null;
  const field = raw.field;
  const op = OPS.includes(raw.op) ? raw.op : 'any';
  if (field === 'kind' && !['any', 'none'].includes(op)) return null;
  if (NEEDS_DAY.has(op)) {
    const day = String(Array.isArray(raw.values) ? raw.values[0] : '').slice(0, 10);
    return DAY.test(day) ? { field, op, values: [day] } : null;
  }
  if (!NEEDS_VALUES.has(op)) return { field, op, values: [] };
  let values = cleanValues(field, raw.values);
  if (field === 'kind') values = values.filter((v) => KINDS.includes(v));
  return values.length ? { field, op, values } : null;
}

/** A stored collection, with anything unrecognised dropped. */
export function normalizeCollection(raw) {
  const r = plain(raw) ? raw : {};
  return {
    match: MATCHES.includes(r.match) ? r.match : 'all',
    rules: (Array.isArray(r.rules) ? r.rules : []).map(normalizeRule).filter(Boolean).slice(0, LIMITS.rules),
  };
}

// ── What the API accepts ─────────────────────────────────────────────────────

function checkRule(raw, i, schema) {
  const at = `Rule ${i + 1}`;
  if (!plain(raw)) return bad(`${at} must be an object with a field, an op and values.`);
  const extra = Object.keys(raw).find((k) => !['field', 'op', 'values'].includes(k));
  if (extra) return bad(`${at}: "${String(extra).slice(0, 40)}" is not part of a rule.`);
  const field = String(raw.field || '');
  if (!FIELD.test(field)) return bad(`${at}: the field must be kind, tag or a metadata field.`);
  const key = metaKey(field);
  if (key && schema && !schema.fields.some((f) => f.key === key)) return bad(`${at}: there is no metadata field "${key}".`);
  const op = raw.op === undefined ? 'any' : raw.op;
  if (!opsFor(field, schema).includes(op)) return bad(`${at}: "${String(op).slice(0, 20)}" does not apply to that field.`);
  if (raw.values !== undefined && !Array.isArray(raw.values)) return bad(`${at}: values must be a list.`);
  if (NEEDS_DAY.has(op)) {
    const day = String(raw.values?.[0] ?? '');
    if (!DAY.test(day)) return bad(`${at}: give a day as YYYY-MM-DD.`);
    return { value: { field, op, values: [day] } };
  }
  if (!NEEDS_VALUES.has(op)) return { value: { field, op, values: [] } };
  if ((raw.values || []).length > LIMITS.values) return bad(`${at}: at most ${LIMITS.values} values.`);
  const values = cleanValues(field, raw.values);
  if (!values.length) return bad(`${at}: give at least one value.`);
  if (field === 'kind') {
    const unknown = values.find((v) => !KINDS.includes(v));
    if (unknown) return bad(`${at}: kinds are ${KINDS.join(', ')}.`);
  }
  return { value: { field, op, values } };
}

/**
 * A collection as the API takes it: { name, driveId?, match?, rules? }.
 * `partial` for a PATCH, where an absent key keeps what is stored. `schema`
 * (normalizeSchema) checks that a metadata field exists and what it compares.
 * Resolves { value } or { error }.
 */
export function validateCollectionInput(body, { partial = false, schema = null } = {}) {
  if (!plain(body)) return bad('Send the collection as a JSON object.');
  const extra = Object.keys(body).find((k) => !['name', 'driveId', 'match', 'rules'].includes(k));
  if (extra) return bad(`"${String(extra).slice(0, 40)}" is not part of a collection.`);
  const value = {};

  if (body.name !== undefined || !partial) {
    if (typeof body.name !== 'string' || !body.name.trim()) return bad('Give the collection a name.');
    const name = body.name.trim().replace(/\s+/g, ' ');
    if (name.length > LIMITS.name) return bad(`Keep the name to ${LIMITS.name} characters.`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(name)) return bad('The name has a character it cannot use.');
    value.name = name;
  }
  if (body.driveId !== undefined) {
    if (partial) return bad('A collection stays in the drive it was made in.');
    if (body.driveId !== null && body.driveId !== '' && (typeof body.driveId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.driveId))) {
      return bad('driveId must be a drive id, or empty for All Files.');
    }
    value.driveId = body.driveId || '';
  } else if (!partial) {
    value.driveId = '';
  }
  if (body.match !== undefined || !partial) {
    const match = body.match === undefined ? 'all' : body.match;
    if (!MATCHES.includes(match)) return bad('match must be "all" or "any".');
    value.match = match;
  }
  if (body.rules !== undefined || !partial) {
    const rules = body.rules === undefined ? [] : body.rules;
    if (!Array.isArray(rules)) return bad('rules must be a list.');
    if (rules.length > LIMITS.rules) return bad(`A collection can have at most ${LIMITS.rules} rules.`);
    const out = [];
    for (let i = 0; i < rules.length; i++) {
      const r = checkRule(rules[i], i, schema);
      if (r.error) return r;
      out.push(r.value);
    }
    if (!partial && !out.length) return bad('Add at least one rule, or every file would match.');
    value.rules = out;
  }
  return { value };
}

/** Two names the same to a person: case and spacing aside. */
export const sameName = (a, b) => str(a, 200).toLowerCase() === str(b, 200).toLowerCase();

/** A rule in words, for a card or a tooltip: "Project is Spring or Summer". */
export function describeRule(rule, schema = null) {
  const key = metaKey(rule.field);
  const label = rule.field === 'kind' ? 'Kind'
    : rule.field === 'tag' ? 'Tag'
    : schema?.fields?.find((f) => f.key === key)?.label || key;
  const vals = rule.values.join(' or ');
  switch (rule.op) {
    case 'none': return `${label} is not ${vals}`;
    case 'set': return rule.field === 'tag' ? 'Has a tag' : `${label} is set`;
    case 'unset': return rule.field === 'tag' ? 'Has no tags' : `${label} is not set`;
    case 'before': return `${label} before ${rule.values[0]}`;
    case 'after': return `${label} after ${rule.values[0]}`;
    default: return `${label} is ${vals}`;
  }
}

/** Who may see a collection: anyone who can open its drive; All Files, everyone. */
export function collectionVisible(collection, drives = []) {
  return !collection.driveId || drives.some((d) => d.id === collection.driveId);
}
