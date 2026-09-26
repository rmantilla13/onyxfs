/**
 * One page of a file listing, authorized → filtered → presigned: what GET
 * /api/files returns, and what the files page renders on the server so a
 * folder's files are in the first paint rather than a round trip after it.
 * One function for both, so the page can never show a row the API would not.
 *
 * Server-only (database and storage).
 */
import { listFilesForUser, listFileFoldersForUser, getFilespaceForUser } from './db.js';
import { presignFileUrls } from './storage.js';
import { encodeCursor } from './file-query.js';

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
  return { files: await presignFileUrls(files), cursor: encodeCursor(cursor), total };
}

/** The sidebar's folder tree for this scope, filtered to what the principal may see. */
export function listFolderTree({ principal, storagePrefix }) {
  return listFileFoldersForUser(principal, { storagePrefix, filespace: storagePrefix });
}
