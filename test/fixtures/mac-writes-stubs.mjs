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
// The UPDATEs keep their WHERE clauses (replaceFileContent's above all).
//
// Folder rows are keyed as the table's unique index keys them: a name within
// a scope (the drive's prefix, '' for the library). `globalNames` stands for
// the old primary key on the name alone, while it is still there. The SQL
// itself is test/replace-content-db.test.js's and test/folder-scope-db.test.js's,
// against a real database.

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
  // As folderRoleFor: every path in a drive is the drive's own.
  const fromDrive = DRIVE_WRITE_ROLES.has(driveRole) && tag ? driveRole : null;
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
    fileCreatedAt: data.fileCreatedAt ?? null, fileModifiedAt: data.fileModifiedAt ?? null,
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
// A thumbnail recorded after the fact, as lib/db.js's setFileThumbnail
// records it: the siblings and the poster that came with it or none, the
// media facts merged in, and seq moved — not version, nor updatedAt.
export async function setFileThumbnail(id, thumbnailKey, media = {}, posterKey = null, thumbSizes = null) {
  const row = s().files.get(String(id));
  if (!row) return null;
  Object.assign(row, {
    thumbnailKey, thumbnailUrl: null, posterKey: posterKey || null, thumbSizes: thumbSizes || [],
    metadata: { ...row.metadata, ...media }, seq: nextSeq(),
  });
  return copy(row);
}
export async function setFilePoster(id, posterKey, media = {}) {
  const row = s().files.get(String(id));
  if (!row) return null;
  row.posterKey = posterKey;
  row.metadata = { ...media, ...row.metadata };
  return copy(row);
}
// The proxy queue, as far as POST /api/files needs it: asking for one is a row
// keyed by file id, so the test can see WHETHER a heavy upload queued one. The
// lease and the atomic claim are lib/db.js's, against a real database
// (test/proxies.test.js pins their SQL).
export async function requestProxy(fileId, { requestedBy = null } = {}) {
  const row = { fileId, status: 'queued', requestedBy, requestedAt: now(), proxyKey: null, sourceKey: null };
  (s().proxies ||= new Map()).set(String(fileId), row);
  return copy(row);
}
export async function getProxy(fileId) { return copy(s().proxies?.get(String(fileId)) || null); }
export async function getProxies(ids = []) {
  const m = new Map();
  for (const id of ids) { const r = s().proxies?.get(String(id)); if (r) m.set(String(id), copy(r)); }
  return m;
}
export async function attachProxies(files = []) { return files; }
export async function proxyKeysFor(ids = []) {
  const list = Array.isArray(ids) ? ids : [ids];
  return list.map((id) => s().proxies?.get(String(id))?.proxyKey).filter(Boolean);
}
export async function proxyKeysInUse(keys = []) {
  const held = new Set([...(s().proxies?.values() || [])].map((r) => r.proxyKey).filter(Boolean));
  return new Set(keys.filter((k) => held.has(k)));
}
function deleteProxyRow(id) { s().proxies?.delete(String(id)); }

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
export async function replaceFileContent(id, { fromKey, toKey, url, size = null, mime = null, kind = null, contentHash = null, fileModifiedAt = null } = {}) {
  const row = s().files.get(String(id));
  if (!row || row.deletedAt || row.storageKey !== fromKey) return null;
  const metadata = { ...row.metadata };
  for (const k of MEDIA_KEYS) delete metadata[k];
  Object.assign(row, {
    storageKey: toKey, url, size, mime: mime ?? row.mime, kind: kind ?? row.kind, contentHash,
    fileModifiedAt: fileModifiedAt ?? now(), // as the SQL: the one given, else now; created stays
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
// lib/trash-move.js's three, with the real queries' WHERE clauses.
export async function setTrashKeyIfUnmoved(id, { trashKey, storageKey } = {}) {
  const row = s().files.get(id);
  if (!row || !row.deletedAt || row.trashKey || row.storageKey !== storageKey) return false;
  row.trashKey = trashKey;
  return true;
}
export async function trashedRowAtKey(key) {
  const rows = [...s().files.values()];
  if (rows.some((f) => f.storageKey === key && !f.deletedAt)) return null;
  const hit = rows.filter((f) => f.storageKey === key && f.deletedAt && !f.trashKey)
    .sort((a, b) => b.deletedAt - a.deletedAt)[0];
  return copy(hit || null);
}
export async function listUnmovedTrash({ limit = 200, maxBytes } = {}) {
  const rows = [...s().files.values()];
  return rows
    .filter((f) => f.deletedAt && !f.trashKey && f.storage === 's3' && f.storageKey
      && (!(maxBytes > 0) || (f.size || 0) <= maxBytes)
      && !rows.some((o) => o.id !== f.id && holds(o, f.storageKey)))
    .sort((a, b) => a.deletedAt - b.deletedAt)
    .slice(0, limit)
    .map(copy);
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
  // As the real one: a purge takes the file's dependents with it.
  deleteProxyRow(id);
  return { ok: true };
}
export async function getTrashedFiles(ids = []) { return ids.map((id) => s().files.get(id)).filter((f) => f?.deletedAt).map(copy); }
// As the real one: a trashed file whose object has moved no longer holds its old key.
const holds = (f, key) => (f.storageKey === key && (!f.deletedAt || !f.trashKey)) || f.trashKey === key;
export async function storageKeyInUse(key, { exceptId = null } = {}) {
  return [...s().files.values()].some((f) => holds(f, key) && f.id !== (exceptId || ''));
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
  for (const { tag: t, name } of rowsOf()) if (t === tag && !counts.has(name)) counts.set(name, 0);
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
// As the SQL: held by an unexpired key someone else holds, or one bound to
// new contents — or any, when the asker wants a key for new contents.
export async function uploadKeyHeld(key, { by = null, forReplacement = false } = {}) {
  for (const [k, row] of s().uploadKeys) {
    const at = k.lastIndexOf('|');
    if (k.slice(0, at) !== key || row.issuedAt < now() - UPLOAD_KEY_TTL_MS) continue;
    if (forReplacement || row.replaceOf || k.slice(at + 1) !== norm(by)) return true;
  }
  return false;
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
// s().folders: Map `${tag}\u0000${name}` → { tag, name } (a control
// character can never be in a folder name, lib/folder-ops.js).
const fkey = (tag, name) => `${tag}\u0000${name}`;
const rowsOf = () => [...s().folders.values()];
const nameTaken = (tag, name) => rowsOf().some((r) => r.name === name && (r.tag === tag || s().globalNames));
function addFolder(path, tag) {
  let p = '';
  let made = false;
  for (const seg of path.split('/')) {
    p = p ? `${p}/${seg}` : seg;
    const inserted = !nameTaken(tag, p);
    if (inserted) s().folders.set(fkey(tag, p), { tag, name: p });
    if (p === path) made = inserted;
  }
  return made;
}
export async function createFolder(name, { filespace } = {}) {
  const tag = String(filespace || '');
  const created = addFolder(clean(name), tag);
  return { name: clean(name), created, existed: !created && s().folders.has(fkey(tag, clean(name))) };
}
export async function listFolderRowsUnder(name, { tag = '' } = {}) {
  return rowsOf().filter((r) => r.tag === tag && r.name.startsWith(`${name}/`)).map((r) => r.name);
}
export async function folderPathInUse(path, { tag = '', prefix = null } = {}) {
  const within = prefix ? `${clean(prefix)}/` : null;
  return rowsOf().some((r) => r.tag === tag && under(r.name, path))
    || live().some((f) => under(f.folder, path) && (!within || String(f.storageKey || '').startsWith(within)));
}
export async function renameSpreadsGrants(from, to, { tag = '', outside = 0 } = {}) {
  if (tag && (outside > 0 || rowsOf().some((r) => r.tag !== tag && under(r.name, from)))) return false;
  const granted = (s().folderGrants || []).some((g) => under(g, from));
  return granted && (rowsOf().some((r) => r.tag !== tag && under(r.name, to)) || live().some((f) => under(f.folder, to)));
}
export async function listFolderSubtreeFiles(folder) {
  if (!folder) return [];
  return live().filter((f) => under(f.folder, folder)).map((f) => ({
    id: f.id, name: f.name, folder: f.folder, storage: f.storage, storageKey: f.storageKey,
    thumbnailKey: f.thumbnailKey, posterKey: f.posterKey, filmstripKey: f.filmstripKey,
  }));
}
export async function renameFolder(from, to, { tag = '', moves = [], catalog = [] } = {}) {
  const mine = rowsOf().filter((r) => r.tag === tag && under(r.name, from));
  // As the one statement: every row lands, or the whole rename fails.
  for (const r of mine) {
    const next = to + r.name.slice(from.length);
    if (nameTaken(tag, next) && !mine.some((m) => m.name === next)) throw new Error('duplicate key value violates unique constraint');
  }
  let files = 0;
  for (const m of [...moves, ...catalog]) {
    const row = s().files.get(m.id);
    if (!row || row.deletedAt) continue;
    if (m.toKey) followTranscripts(m.id, m.toKey);
    Object.assign(row, { folder: m.folder, storageKey: m.toKey || row.storageKey });
    touch(row);
    files++;
  }
  for (const r of mine) s().folders.delete(fkey(tag, r.name));
  for (const r of mine) {
    const name = to + r.name.slice(from.length);
    s().folders.set(fkey(tag, name), { tag, name });
  }
  const parent = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '';
  if (parent) addFolder(parent, tag);
  if (!s().folders.has(fkey(tag, to)) && !nameTaken(tag, to)) s().folders.set(fkey(tag, to), { tag, name: to });
  return { ok: true, from, to, files, folders: mine.length };
}
export async function deleteFolderRows(name, { tag = '' } = {}) {
  for (const r of rowsOf()) if (r.tag === tag && under(r.name, name)) s().folders.delete(fkey(tag, r.name));
  return { ok: true, remaining: live().filter((f) => under(f.folder, name)).length };
}

// ── what the storage layer and the write routes read besides ──
// Every drive, as the storage layer reads them (listDriveStorage: with
// their secrets; these have none, so every one is the base bucket's).
export async function listDriveStorage() { return s().drives.map((d) => copy(d)); }
export async function listFilespaces() { return s().drives.map((d) => copy(d)); }
// The stored spellings (non-ASCII paths) of a scope, and the canonical path:
// the same composition as lib/db.js, over the store.
export async function folderSpellings({ tag = '', prefix = null } = {}) {
  const within = prefix ? `${clean(prefix)}/` : null;
  const nonAscii = (p) => /[^\x00-\x7f]/.test(p);
  return [...new Set([
    ...live().filter((f) => nonAscii(f.folder || '') && (!within || String(f.storageKey || '').startsWith(within))).map((f) => f.folder),
    ...rowsOf().filter((r) => r.tag === clean(tag) && nonAscii(r.name)).map((r) => r.name),
  ])];
}
export async function canonicalFolder(path, { tag = '', prefix = null } = {}) {
  const { cleanFolder, nfc, isAscii, respellPath } = await import('../../lib/folder-ops.js');
  const c = nfc(cleanFolder(path));
  if (!c || isAscii(c)) return c;
  return respellPath(c, await folderSpellings({ tag, prefix }));
}
// Who sees which files: the listing's rule, as far as this store keeps it —
// an admin every one; anyone else a file they made, or one visible to all.
export async function visibleFileIds(ids, principal = {}) {
  const list = (ids || []).map(String);
  if (principal.isAdmin) return new Set(list);
  const me = norm(principal.email);
  return new Set(list.filter((id) => {
    const f = s().files.get(id);
    return f && ((f.visibility ?? 'org') === 'org' || norm(f.createdBy) === me);
  }));
}
