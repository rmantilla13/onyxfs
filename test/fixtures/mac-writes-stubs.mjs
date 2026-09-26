// Stand-in for lib/db.js, for test/mac-writes-api.test.js: the routes Onyx
// for Mac writes through run for real — requirePrincipal and the desktop
// guard, getPrincipal and can(), lib/storage.js, lib/preview-gc.js,
// lib/replace-content.js — and only the database is replaced, by an
// in-memory store in globalThis.__mw that the test arranges. (The bucket is
// replaced one level further down, at the S3 client's send(); see the test.)
//
// The access answers are computed, not configured: canModifyFile is the real
// fileWriteDecision over the real driveAccess, getFilespaceForWrite the real
// canWriteDrive, canModifyFolder the real folderRoleAllows — imported from
// the modules that define them — so a refusal here is the rule refusing.
// The UPDATEs keep their WHERE clauses (replaceFileContent's above all). The
// SQL itself is test/replace-content-db.test.js's, against a real database.

import { fileWriteDecision, folderRoleAllows, strongestFolderRole } from '../../lib/db.js';
import { driveAccess, canWriteDrive, DRIVE_WRITE_ROLES } from '../../lib/drive-access.js';
import { MEDIA_KEYS } from '../../lib/media.js';

export const UPLOAD_KEY_TTL_MS = 24 * 60 * 60 * 1000;
const s = () => globalThis.__mw;
const now = () => s().now ?? Date.now();
const copy = (v) => (v == null ? null : structuredClone(v));
const norm = (e) => String(e || '').trim().toLowerCase();
const clean = (p) => String(p || '').replace(/^\/+|\/+$/g, '');
const nextSeq = () => ++s().seq;
const live = () => [...s().files.values()].filter((f) => !f.deletedAt);
const under = (folder, a) => folder === a || String(folder || '').startsWith(`${a}/`);

// ── settings, people, tokens ──
export async function getSetting(key) { return copy(s().settings.get(key) ?? null); }
export async function setSetting(key, value) { s().settings.set(key, copy(value)); }
export async function getPersonByEmail(email) { return copy(s().people.get(norm(email)) || null); }
export async function upsertPerson(email) { return getPersonByEmail(email); }
export async function touchPersonSeen() {}
export async function sessionRowFor(email) {
  const e = norm(email);
  return { person: copy(s().people.get(e) || null), inviteStatus: s().invites.has(e) ? 'approved' : null, avatar: null, deviceOk: true };
}
export async function isEmailApprovedInvite(email) {
  const e = norm(email);
  return s().invites.has(e) && s().people.get(e)?.status !== 'suspended';
}
export async function getDesktopTokenByRaw(raw) {
  const t = s().tokens.get(raw);
  if (!t || (t.expiresAt != null && t.expiresAt < now())) return null;
  return { id: t.id, email: t.email, label: null, createdAt: 0, expiresAt: t.expiresAt ?? null };
}
export async function touchDesktopToken() {}
export async function insertAuditEvent(e) { s().audit.push(e); return { id: String(s().audit.length), at: now() }; }
export async function getFileMetadataSchema() { return null; }

// ── drives and access ──
function drive(id) { return s().drives.find((d) => d.id === id) || null; }
export async function loadDriveGrants(email) {
  const e = norm(email);
  const roles = {};
  for (const [k, role] of s().grants) {
    const [id, who] = k.split('|');
    if (who === e) roles[id] = role;
  }
  return {
    drives: s().drives.map((d) => ({ id: d.id, prefix: d.prefix, shareKinds: null, quotaBytes: d.quotaBytes ?? null })),
    roles, isAdmin: false,
  };
}
export async function folderGrantsFor() { return []; }
export async function getFilespaceForUser(email, id, principal) {
  const role = principal?.isAdmin ? 'owner' : (principal?.driveScope?.roles?.[id] || null);
  const fs = role ? drive(id) : null;
  return fs ? { ...copy(fs), role } : null;
}
export async function getFilespaceForWrite(email, id, principal) {
  const fs = await getFilespaceForUser(email, id, principal);
  return fs && canWriteDrive(fs.role) ? fs : null;
}
const scopeOf = (p) => (p.isAdmin ? { drives: [], roles: {}, isAdmin: true } : p.driveScope);
const aclOf = (fileId, p) => s().acl.get(`${fileId}|${norm(p.email)}`) || null;

export async function canAccessFile(file, p = {}) {
  if (!file) return false;
  if (p.isAdmin) return true;
  const d = driveAccess(file.storageKey, scopeOf(p));
  if (d.inDrive && !d.read) return !!aclOf(file.id, p);
  if (norm(file.createdBy) === norm(p.email)) return true;
  if (file.visibility === 'org') return true;
  return !!aclOf(file.id, p);
}
export async function modifiableFileIds(files, p = {}, { action = 'files.edit' } = {}) {
  const out = new Set();
  for (const f of files || []) {
    if (!f) continue;
    const access = aclOf(f.id, p);
    const d = fileWriteDecision({
      file: f, principal: p, fileAccess: DRIVE_WRITE_ROLES.has(access) ? access : null,
      folderRoles: [], drive: p.isAdmin ? null : driveAccess(f.storageKey, scopeOf(p)), action,
    });
    if (d.allowed) out.add(f.id);
  }
  return out;
}
export async function canModifyFile(file, p = {}, { action = 'files.edit' } = {}) {
  if (!file) return false;
  return (await modifiableFileIds([file], p, { action })).has(file.id);
}
export async function canModifyFolder(folder, p = {}, { driveRole = null, tag = null } = {}) {
  if (p.isAdmin) return true;
  let fromDrive = null;
  if (DRIVE_WRITE_ROLES.has(driveRole) && tag) {
    const outside = [...s().folders].some(([name, t]) => under(name, folder) && t !== String(tag));
    fromDrive = outside ? null : driveRole;
  }
  return folderRoleAllows(strongestFolderRole([fromDrive]), 'modify');
}

// ── files ──
export async function getFileById(id) { return copy(s().files.get(String(id)) || null); }
export async function createFile(data = {}) {
  const id = crypto.randomUUID();
  const row = {
    id, name: (data.name || 'Untitled').trim(), folder: data.folder || '', kind: data.kind || 'other', mime: data.mime || null,
    size: data.size != null ? Number(data.size) : null, url: data.url, storage: data.storage || 'blob', storageKey: data.storageKey || null,
    tags: data.tags || [], notes: data.notes || null, visibility: data.visibility || 'org',
    thumbnailUrl: null, thumbnailKey: data.thumbnailKey || null, filmstripKey: data.filmstripKey || null,
    posterKey: data.posterKey || null, thumbSizes: data.thumbSizes || [],
    deletedAt: null, trashKey: null, deletedBy: null, version: 1, contentHash: data.contentHash || null,
    metadata: data.metadata || {}, createdBy: data.createdBy || null, createdAt: now(), updatedAt: now(), seq: nextSeq(),
  };
  s().files.set(id, row);
  return copy(row);
}
function touch(row) { Object.assign(row, { version: (row.version || 1) + 1, updatedAt: now(), seq: nextSeq() }); }
export async function updateFile(id, fields = {}) {
  const row = s().files.get(id);
  if (!row) return null;
  for (const k of ['name', 'folder', 'notes']) if (fields[k] != null) row[k] = fields[k];
  if (fields.tags !== undefined) row.tags = fields.tags;
  if (fields.metadata && typeof fields.metadata === 'object') row.metadata = { ...row.metadata, ...fields.metadata };
  touch(row);
  return copy(row);
}
function followTranscripts(id, toKey) {
  const t = s().transcripts.get(id);
  const row = s().files.get(id);
  if (t && row && t.sourceKey === row.storageKey) t.sourceKey = toKey;
}
export async function setFileStorageKey(id, storageKey) {
  const row = s().files.get(id);
  followTranscripts(id, storageKey);
  if (row) { row.storageKey = storageKey; touch(row); }
  return { ok: true };
}
// As the SQL: only a live row still at `fromKey`; no transcript follows.
export async function replaceFileContent(id, { fromKey, toKey, url, size = null, mime = null, kind = null, contentHash = null } = {}) {
  const row = s().files.get(String(id));
  if (!row || row.deletedAt || row.storageKey !== fromKey) return null;
  const metadata = { ...row.metadata };
  for (const k of MEDIA_KEYS) delete metadata[k];
  Object.assign(row, {
    storageKey: toKey, url, size, mime: mime ?? row.mime, kind: kind ?? row.kind, contentHash,
    thumbnailKey: null, thumbnailUrl: null, posterKey: null, thumbSizes: [], filmstripKey: null, metadata,
  });
  touch(row);
  return copy(row);
}
export async function softDeleteFile(id, { trashKey = null, deletedBy = null } = {}) {
  const row = s().files.get(id);
  if (!row) return null;
  Object.assign(row, { deletedAt: now(), trashKey, deletedBy, updatedAt: now(), seq: nextSeq() });
  return copy(row);
}
export async function restoreFile(id, { storageKey = null } = {}) {
  const row = s().files.get(id);
  if (!row || !row.deletedAt) return null;
  if (storageKey) followTranscripts(id, storageKey);
  Object.assign(row, { deletedAt: null, trashKey: null, deletedBy: null, storageKey: storageKey ?? row.storageKey });
  touch(row);
  return copy(row);
}
export async function deleteFile(id) {
  s().tombstones.push({ id, seq: nextSeq() });
  s().files.delete(id);
  return { ok: true };
}
export async function getTrashedFiles(ids = []) { return ids.map((id) => s().files.get(id)).filter((f) => f?.deletedAt).map(copy); }
export async function storageKeyInUse(key, { exceptId = null } = {}) {
  return [...s().files.values()].some((f) => (f.storageKey === key || f.trashKey === key) && f.id !== (exceptId || ''));
}
export async function unreferencedPreviewKeys({ thumbKeys = [], posterKeys = [] } = {}) {
  const rows = [...s().files.values()];
  return [
    ...thumbKeys.filter((k) => !rows.some((f) => f.thumbnailKey === k)),
    ...posterKeys.filter((k) => !rows.some((f) => f.posterKey === k)),
  ];
}
export async function previewKeysInUse(keys = [], { exceptId = null } = {}) {
  const rows = [...s().files.values()].filter((f) => f.id !== exceptId);
  return new Set(keys.filter((k) => k && rows.some((f) => [f.thumbnailKey, f.posterKey, f.filmstripKey].includes(k))));
}
export async function usedBytesBy(email) {
  return live().filter((f) => norm(f.createdBy) === norm(email)).reduce((n, f) => n + (Number(f.size) || 0), 0);
}
export async function countFilesUnderPrefix(prefix) {
  const p = `${clean(prefix)}/`;
  const rows = live().filter((f) => String(f.storageKey || '').startsWith(p));
  return { files: rows.length, bytes: rows.reduce((n, f) => n + (Number(f.size) || 0), 0) };
}
export async function listFilesForUser(opts = {}, p = {}) {
  const sp = opts.storagePrefix ? `${clean(opts.storagePrefix)}/` : null;
  const files = [];
  for (const f of live()) {
    if (sp && !String(f.storageKey || '').startsWith(sp)) continue;
    if (opts.folder !== undefined && f.folder !== opts.folder) continue;
    if (await canAccessFile(f, p)) files.push(copy(f));
  }
  return { files, cursor: null, total: files.length };
}
export async function listFileFoldersForUser(p = {}, opts = {}) {
  const { files } = await listFilesForUser({ storagePrefix: opts.storagePrefix }, p);
  const counts = new Map();
  for (const f of files) if (f.folder) counts.set(f.folder, (counts.get(f.folder) || 0) + 1);
  const tag = clean(opts.filespace);
  for (const [name, t] of s().folders) if (t === tag && !counts.has(name)) counts.set(name, 0);
  return [...counts].sort().map(([folder, count]) => ({ folder, count }));
}

// ── issued upload keys and resumable uploads ──
export async function issueUploadKey(key, email, { bucket = '', replaceOf = null } = {}) {
  s().uploadKeys.set(`${key}|${norm(email)}`, { bucket: String(bucket || ''), issuedAt: now(), replaceOf: replaceOf || null });
}
export async function claimUploadKey(key, email, { replaceOf = null } = {}) {
  const k = `${key}|${norm(email)}`;
  const row = s().uploadKeys.get(k);
  if (!row || row.issuedAt < now() - UPLOAD_KEY_TTL_MS || (row.replaceOf || null) !== (replaceOf || null)) return null;
  s().uploadKeys.delete(k);
  return { bucket: row.bucket };
}
export async function createUpload(data = {}) {
  const row = {
    id: crypto.randomUUID(), uploadId: data.uploadId, storageKey: data.storageKey, filename: data.filename,
    size: data.size != null ? Number(data.size) : null, mime: data.mime || null, folder: data.folder || '',
    filespaceId: data.filespaceId || null, partSize: Number(data.partSize), replaceOf: data.replaceOf || null,
    createdBy: norm(data.createdBy), createdAt: now(), updatedAt: now(),
  };
  s().uploads.set(row.id, row);
  return copy(row);
}
export async function getUpload(id, email) {
  const row = s().uploads.get(id);
  return row && row.createdBy === norm(email) ? copy(row) : null;
}
export async function touchUpload() {}
export async function deleteUpload(id) { s().uploads.delete(id); return { ok: true, id }; }
export async function listUploads(email) { return [...s().uploads.values()].filter((u) => u.createdBy === norm(email)).map(copy); }

// ── folders ──
function addFolder(path, tag) {
  let p = '';
  for (const seg of path.split('/')) {
    p = p ? `${p}/${seg}` : seg;
    if (!s().folders.has(p)) s().folders.set(p, tag);
  }
}
export async function createFolder(name, { filespace } = {}) { addFolder(clean(name), String(filespace || '')); return { name: clean(name) }; }
export async function folderRowTag(name) { return s().folders.has(name) ? s().folders.get(name) : null; }
export async function listFolderRowsUnder(name, { tag = '' } = {}) {
  return [...s().folders].filter(([n, t]) => n.startsWith(`${name}/`) && (t === tag || t === '')).map(([n]) => n);
}
export async function folderPathInUse(path) {
  return [...s().folders.keys()].some((n) => under(n, path)) || live().some((f) => under(f.folder, path));
}
export async function listFolderSubtreeFiles(folder) {
  if (!folder) return [];
  return live().filter((f) => under(f.folder, folder)).map((f) => ({
    id: f.id, name: f.name, folder: f.folder, storage: f.storage, storageKey: f.storageKey,
    thumbnailKey: f.thumbnailKey, posterKey: f.posterKey, filmstripKey: f.filmstripKey,
  }));
}
export async function renameFolder(from, to, { tag = '', moves = [], catalog = [] } = {}) {
  let files = 0;
  for (const m of [...moves, ...catalog]) {
    const row = s().files.get(m.id);
    if (!row || row.deletedAt) continue;
    if (m.toKey) followTranscripts(m.id, m.toKey);
    Object.assign(row, { folder: m.folder, storageKey: m.toKey || row.storageKey });
    touch(row);
    files++;
  }
  let folders = 0;
  for (const [n, t] of [...s().folders]) {
    if (!under(n, from) || !(t === tag || t === '')) continue;
    s().folders.delete(n);
    s().folders.set(to + n.slice(from.length), t);
    folders++;
  }
  const parent = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '';
  if (parent) addFolder(parent, tag);
  if (!s().folders.has(to)) s().folders.set(to, tag);
  return { ok: true, from, to, files, folders };
}
export async function deleteFolderRows(name, { tag = '' } = {}) {
  for (const [n, t] of [...s().folders]) if (under(n, name) && (t === tag || t === '')) s().folders.delete(n);
  return { ok: true, remaining: live().filter((f) => under(f.folder, name)).length };
}
