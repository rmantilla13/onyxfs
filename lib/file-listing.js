/**
 * One page of a file listing, authorized → filtered → presigned: what GET
 * /api/files returns, and what the files page renders on the server so a
 * folder's files are in the first paint rather than a round trip after it.
 * One function for both, so the page can never show a row the API would not.
 *
 * Server-only (database and storage).
 */
import { listFilesForUser, listFileFoldersForUser, getFilespaceForUser, modifiableFileIds, finishedProxyKeys } from './db.js';
import { presignFileUrls } from './storage.js';
import { encodeCursor } from './file-query.js';
import { principalHasCap } from './roles.js';
import { isFeatureEnabled } from './features.js';
import { shouldProxy } from './proxies.js';

/**
 * A filespace's prefix, when the caller may use it; undefined for the whole
 * library (no filespace asked for); null when one was asked for that they
 * may not open, or that is not there. Null is a refusal, never the library:
 * a drive id that stopped being theirs answering with some other listing is
 * how a client comes to show the wrong files under a drive's name.
 */
export async function storagePrefixFor(email, filespaceId, principal = null) {
  if (!filespaceId) return undefined;
  const fs = await getFilespaceForUser(email, filespaceId, principal);
  return fs ? String(fs.prefix || '').replace(/^\/+|\/+$/g, '') : null;
}

/**
 * `opts` are listFilesForUser's (folder, q, kind, sort, cursor, limit, …).
 * Returns { files, cursor, total, totalBytes } with the files presigned and
 * the cursor encoded, ready to send. The totals are there only when asked for
 * (`withTotal`): how many rows match, and what they weigh.
 */
export async function listFilesPage({ principal, opts = {}, storagePrefix }) {
  // AUTHORIZE → FILTER → PRESIGN. Access and filtering happen inside the
  // query, so only the rows on this page are ever signed — and only they are
  // asked about after it: what the caller may do to each, and the streamable
  // copy of each heavy video, which Quick Look plays rather than the master.
  // Neither answer needs the other, so the two are asked together.
  const { files, cursor, total, totalBytes } = await listFilesForUser({ ...opts, storagePrefix }, principal);
  const [rows, proxies] = await Promise.all([
    withFileCan(files, principal),
    playableProxies(files, principal?.flags),
  ]);
  // No scrub strips: no tile scrubs, and each signed URL is ~400 bytes of
  // every page. The detail page signs its own.
  const signed = await presignFileUrls(withProxyKeys(rows, proxies), { filmstrip: false });
  return { files: signed, cursor: encodeCursor(cursor), total, totalBytes };
}

/**
 * The finished, current proxy (lib/proxies.js) of each video among `files`
 * big enough to have one, as a Map of file id → key for withProxyKeys — so
 * presignFileUrls signs it as `proxyUrl`, which the players prefer. Also the
 * share page's, for its one file.
 *
 * Empty when the `proxies` flag is off in `flags` — off, an existing proxy is
 * not served — and without a query when no row is a video worth a proxy
 * (shouldProxy), which is most pages. A lookup that fails is no proxy: the
 * master plays, as it always has. For rows already filtered to the caller
 * only, like everything signed from them.
 */
export async function playableProxies(files, flags) {
  if (!Array.isArray(files) || !isFeatureEnabled(flags, 'proxies')) return new Map();
  const heavy = files.filter((f) => f && shouldProxy(f));
  if (!heavy.length) return new Map();
  try {
    return await finishedProxyKeys(heavy);
  } catch {
    return new Map();
  }
}

/** Each of `files` with its proxy key from `keys` (playableProxies), for presignFileUrls to sign. */
export function withProxyKeys(files, keys) {
  if (!Array.isArray(files) || !keys?.size) return files;
  return files.map((f) => (f && keys.has(f.id) ? { ...f, proxyKey: keys.get(f.id) } : f));
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
