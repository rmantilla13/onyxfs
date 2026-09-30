// Stand-in for lib/db.js, for test/previews-route.test.js: GET
// /api/admin/previews/candidates runs for real — requireAdmin and the
// session, lib/storage.js's presigning — with the database replaced by rows
// in globalThis.__pv that the test arranges. Which rows a page holds is
// lib/preview-jobs.js's rule applied in JS: the rule the SQL is held to in
// test/previews-db.test.js. The arguments the route passed are recorded, so
// the test can see the scope it asked for.

import { previewClass, previewGaps } from '../../lib/preview-jobs.js';
import { effectiveKind } from '../../lib/media.js';
import { cleanFolder, nfc } from '../../lib/folder-ops.js';

const s = () => globalThis.__pv;
const norm = (e) => String(e || '').trim().toLowerCase();

// ── settings, the session, drives ──
export async function getSetting(key) { return s().settings.get(key) ?? null; }
export async function setSetting(key, value) { s().settings.set(key, value); }
export async function listDriveStorage() { return []; }
export async function sessionRowFor(email) {
  s().calls.push(['sessionRowFor', norm(email)]);
  return { person: null, inviteStatus: s().approved.has(norm(email)) ? 'approved' : null, avatar: null, deviceOk: true };
}
export async function upsertPerson() { return null; }
export async function touchPersonSeen() {}
export async function getFilespace(id) {
  s().calls.push(['getFilespace', id]);
  return s().drives.find((d) => d.id === id) || null;
}
export async function canonicalFolder(path) { return nfc(cleanFolder(path)); }

// ── the candidates ──
function inScope(f, { kinds = ['image', 'video'], prefix = null, folder = null }) {
  if (f.deletedAt || f.storage !== 's3') return false;
  if (!kinds.includes(effectiveKind(f)) || !previewClass(f)) return false;
  if (prefix && !String(f.storageKey || '').startsWith(`${prefix}/`)) return false;
  if (folder && !(f.folder === folder || String(f.folder || '').startsWith(`${folder}/`))) return false;
  return true;
}
function listed(f, { classes, mode }) {
  if (mode === 'everything') return classes.includes(previewClass(f));
  const gaps = previewGaps(f);
  return (classes.includes(previewClass(f)) && gaps.length > 0) || gaps.includes('sizes') || gaps.includes('placeholder');
}
const sorted = () => [...s().files].sort((a, b) => (a.id < b.id ? -1 : 1));

export async function listPreviewCandidates(args) {
  s().calls.push(['listPreviewCandidates', args]);
  const n = Math.min(Math.max(1, Math.floor(Number(args.limit)) || 50), 200);
  const rows = sorted().filter((f) => inScope(f, args) && listed(f, args) && f.id > String(args.after || '')).slice(0, n);
  return { files: rows.map((f) => structuredClone(f)), after: rows.length ? rows[rows.length - 1].id : String(args.after || ''), done: rows.length < n };
}

export async function countPreviewCandidates(args) {
  s().calls.push(['countPreviewCandidates', args]);
  const out = { total: 0, heic: 0, tiff: 0, never: 0 };
  for (const f of sorted().filter((x) => inScope(x, args))) {
    if (args.mode !== 'everything' && !previewGaps(f).length) continue;
    if (listed(f, args)) out.total += 1;
    else if (previewClass(f) in out) out[previewClass(f)] += 1;
  }
  return out;
}
