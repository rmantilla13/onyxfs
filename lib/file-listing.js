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
import { mapLimit } from './folder-ops.js';

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
 * that should have one — big enough, or encoded so that some browser will
 * not play it — as a Map of file id → key for withProxyKeys, so
 * presignFileUrls signs it as `proxyUrl`, which the players prefer. Also the
 * share page's, for its one file.
 *
 * Empty when the `proxies` flag is off in `flags` — off, an existing proxy is
 * not served — and without a query when no row is a video worth a proxy
 * (shouldProxy): a page of documents and stills. A page of phone clips, HEVC
 * nearly all of them, asks — one indexed lookup of its own ids. A lookup
 * that fails is no proxy: the master plays, as it always has. For rows
 * already filtered to the caller only, like everything signed from them.
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

/** How many pictures a folder's preview holds, and how many folders one call may ask about. */
export const PREVIEW_PER_FOLDER = 4;
export const PREVIEW_MAX_FOLDERS = 24;

/**
 * One picture of a folder's preview, cut down to what a mosaic draws: the
 * file's id and name, and its own thumbnails — never the original, its
 * poster or its streamable copy, which a preview has no use for and which
 * would put full-size addresses in every listing. Its shape and the tiny
 * placeholder, so a cell is filled the moment it is drawn.
 */
export function previewTile(file) {
  const md = file?.metadata && typeof file.metadata === 'object' ? file.metadata : {};
  const sizes = Array.isArray(file?.thumbSizes) ? file.thumbSizes : [];
  const pick = (size) => (sizes.includes(size) && typeof file[`${size}Url`] === 'string' ? file[`${size}Url`] : null);
  return {
    id: file.id,
    name: file.name,
    xs: pick('xs'),
    sm: pick('sm'),
    grid: typeof file.thumbnailUrl === 'string' ? file.thumbnailUrl : null,
    width: Number(md.width) > 0 ? Number(md.width) : null,
    height: Number(md.height) > 0 ? Number(md.height) : null,
    placeholder: typeof md.placeholder === 'string' ? md.placeholder : null,
  };
}

/**
 * What is in each of `folders`: its newest pictures, the folder and
 * everything beneath it, at most PREVIEW_PER_FOLDER each — for the folder
 * tiles and the drives' cards. `folders` are paths in the scope
 * `storagePrefix` names ('' its top), as the listing takes them.
 *
 * Each is listFilesForUser's own read — the same access, drive boundary,
 * visibility and trash rules as opening the folder flat — narrowed to rows
 * with a thumbnail of their own, newest first. AUTHORIZE → FILTER → PRESIGN:
 * only those rows are signed, and only their thumbnails leave (previewTile).
 * A folder whose read fails has an empty preview: the tile shows its icon,
 * as it would with nothing to show.
 *
 * → an array parallel to `folders`, each an array of previewTile.
 */
export async function folderPreviews({ principal, storagePrefix, folders = [], per = PREVIEW_PER_FOLDER }) {
  const list = (Array.isArray(folders) ? folders : []).slice(0, PREVIEW_MAX_FOLDERS);
  return mapLimit(list, 4, async (folder) => {
    try {
      const { files } = await listFilesForUser({
        folderPrefix: String(folder ?? ''), sort: 'new', limit: per, pictured: true, storagePrefix,
      }, principal);
      if (!files.length) return [];
      const signed = await presignFileUrls(files, { filmstrip: false });
      return signed.map(previewTile).filter((t) => t.xs || t.sm || t.grid);
    } catch (e) {
      console.warn('[folder previews] %s: %s', folder, e.message);
      return [];
    }
  });
}

/** The sidebar's folder tree for this scope, filtered to what the principal may see. */
export function listFolderTree({ principal, storagePrefix }) {
  return listFileFoldersForUser(principal, { storagePrefix, filespace: storagePrefix });
}
