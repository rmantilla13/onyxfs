/**
 * One page of a file listing, authorized → filtered → presigned: what GET
 * /api/files returns, and what the files page renders on the server so a
 * folder's files are in the first paint rather than a round trip after it.
 * One function for both, so the page can never show a row the API would not.
 *
 * Server-only (database and storage).
 */
import { listFilesForUser, listFileFoldersForUser, getFilespaceForUser, modifiableFileIds } from './db.js';
import { presignFileUrls } from './storage.js';
import { encodeCursor } from './file-query.js';
import { principalHasCap } from './roles.js';

/** A filespace's prefix, when the caller may use it; undefined for the whole library. */
export async function storagePrefixFor(email, filespaceId, principal = null) {
  const fs = filespaceId ? await getFilespaceForUser(email, filespaceId, principal) : null;
  return fs ? String(fs.prefix || '').replace(/^\/+|\/+$/g, '') : undefined;
}

/**
 * `opts` are listFilesForUser's (folder, q, kind, sort, cursor, limit, …).
 * Returns { files, cursor, total } with the files presigned and the cursor
 * encoded, ready to send.
 */
export async function listFilesPage({ principal, opts = {}, storagePrefix }) {
  // AUTHORIZE → FILTER → PRESIGN. Access and filtering happen inside the
  // query, so only the rows on this page are ever signed.
  const { files, cursor, total } = await listFilesForUser({ ...opts, storagePrefix }, principal);
  const signed = await presignFileUrls(files);
  return { files: await withFileCan(signed, principal), cursor: encodeCursor(cursor), total };
}

/**
 * Each file with what the caller may do to it — `can: { edit, delete,
 * share }` — for the library's per-file menus (app/files/can-for.js).
 *
 * The routes' own rule: the file half is fileWriteDecision (drive role,
 * creator, grants), asked once for the page through modifiableFileIds, and
 * the role half is the capability each action needs. `share` is the file
 * half only — each kind of link is its own capability, which the page reads
 * from the flags (a role with none has `shares` off). Only rows already
 * filtered to this caller get here, so nothing is said about a file they
 * cannot see.
 */
export async function withFileCan(files, principal) {
  if (!Array.isArray(files) || !files.length) return files;
  const edit = principalHasCap(principal, 'files.edit');
  const del = principalHasCap(principal, 'files.delete');
  // action null: "could they change this file, were their role to allow".
  const writable = await modifiableFileIds(files, principal, { action: null });
  return files.map((f) => {
    const w = writable.has(f.id);
    return { ...f, can: { edit: edit && w, delete: del && w, share: w } };
  });
}

/** The sidebar's folder tree for this scope, filtered to what the principal may see. */
export function listFolderTree({ principal, storagePrefix }) {
  return listFileFoldersForUser(principal, { storagePrefix, filespace: storagePrefix });
}
