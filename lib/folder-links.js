// lib/folder-links.js — what a link to a folder reaches, as pure rules.
//
// A folder link (file_shares.kind = 'folder') is evaluated LIVE: every
// request asks again which files are in the folder, so a file moved out,
// trashed or restricted drops out on the next request, and one added
// appears. What a link reaches is decided here, in one place, as a pure
// function and as the SQL that says the same thing — the page, the listing
// route, the preview and the download all ask through these, so they cannot
// disagree about where the folder ends.
//
// A file is in the link to folder ROOT of a scope when all of these hold:
//
//   live           not in the trash
//   in the bucket  storage 's3' with a key: presigning is how a guest gets
//                  the bytes, and the key is what the boundary is drawn on
//   the workspace's to see   visibility 'org'. A file restricted to certain
//                  people (visibility 'owner' or 'custom') stays out: a link
//                  anyone can hold must not carry what most members of the
//                  folder cannot open themselves
//   in the folder  its folder is ROOT or beneath it, compared as whole path
//                  segments (starts_with 'Q1/', never LIKE 'Q1%' — sharing
//                  "Q1" must not reach "Q10", nor "Q1_2024" reach "Q1-2024")
//   where the folder says  its key is exactly <prefix>/<folder>/<name>, the
//                  layout storage.buildObjectKey writes. A file whose folder
//                  was changed in the catalog without its object moving, or
//                  a key that spells some other place, is not in the link:
//                  both what the Files view shows and where the object is
//                  have to agree before it goes out
//   not the app's own        nothing under a `_thumbs` or `_trash` segment,
//                  and no preview or OS junk (file-query.js artifactClauses)
//   not across a drive boundary  the library's link reaches no file inside
//                  any drive; a drive's link reaches no file inside a drive
//                  that does not allow links of its kind (a client's drive
//                  nested inside a team's, say)
//
// The scope is the link's own, from its row, never from a request:
// `storage_prefix` is the drive's prefix, or NULL for the library, whose
// prefix is the storage config's (as the folders route has it).
//
// Paths in requests (a subfolder to open, a file to preview) are only ever
// used to narrow within ROOT. They are checked here (linkSubpath) before they
// reach a query, and the query then holds every row to ROOT regardless.

import { artifactClauses, FILE_COLUMNS } from './file-query.js';
import { drivesHolding } from './drive-access.js';
import { sharedFile } from './media.js';
import { smallOriginal } from './renditions.js';
import { cleanFolder, folderPathProblem } from './folder-ops.js';

/** Files per page of a folder link's listing, and the most one request may ask for. */
export const LINK_PAGE = 100;
export const LINK_PAGE_MAX = 200;
/** Subfolders one level shows: past this many a link is not the way to browse it. */
export const LINK_FOLDERS_MAX = 1000;
/** The longest subfolder path a request may name. */
export const MAX_LINK_PATH = 1024;

const RESERVED = /^_(thumbs|trash)$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** A `_thumbs` or `_trash` segment anywhere in a path or key, for Postgres (~*). */
export const RESERVED_SEGMENT_RE = '(^|/)_(thumbs|trash)(/|$)';
const RESERVED_SEGMENT = new RegExp(RESERVED_SEGMENT_RE, 'i');
// The artifacts artifactClauses keeps out, for the pure mirror below.
const THUMB_ARTIFACT = /(^|\/)_thumbs\/|(^|\/)[^/]*-thumb-[^/]*\.(jpe?g|png|webp)$/;
const SYSTEM_KEY = /(^|\/)(\.DS_Store|\.localized|Thumbs\.db|desktop\.ini|\._[^/]*)$/;

const clean = (p) => String(p ?? '').replace(/^\/+|\/+$/g, '');
const likeLiteral = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Why `path` cannot be the folder a link is made to, or null. Never the root
 * of a drive or of the library — a link to everything is not a folder link —
 * and never a path the app keeps for itself. `path` as the create request
 * sends it; the route canonicalizes it in its scope after this says yes.
 */
export function linkRootProblem(path) {
  if (typeof path !== 'string') return 'Choose a folder to share.';
  if (!cleanFolder(path)) return 'Choose a folder to share. A whole drive or the whole library cannot be shared by link.';
  return folderPathProblem(path);
}

/** A stored root (file_shares.folder) that is a folder path as the Files view stores one; else null. */
export function storedRoot(folder) {
  const s = typeof folder === 'string' ? folder : '';
  if (!s || s !== cleanFolder(s)) return null;
  return (linkRootProblem(s) || RESERVED_SEGMENT.test(s)) ? null : s;
}

/**
 * A subfolder of the link, as a request names it (`?path=`), relative to the
 * link's folder — or null when it is not one. '' is the link's own folder.
 *
 * Strict rather than forgiving: exactly the canonical form this module's
 * pages link to. No leading, trailing or doubled slash (so no absolute path),
 * no `.` or `..`, no `_thumbs`/`_trash`, no control characters, no segment
 * with space around it (stored names are trimmed). It is decoded once, by
 * the URL parser, and never again: a `%2F` that survives that is a character
 * in a name, not a separator, and matches nothing. None of this is what
 * keeps a request inside the folder — the queries hold every row to it — but
 * a path that could only be a probe is refused before it gets that far.
 */
export function linkSubpath(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw !== 'string' || raw.length > MAX_LINK_PATH) return null;
  for (const seg of raw.split('/')) {
    if (!seg || seg !== seg.trim() || seg === '.' || seg === '..') return null;
    if (RESERVED.test(seg) || CONTROL.test(seg) || seg.length > 255) return null;
  }
  return raw;
}

/** The folder a subpath of the link names: always ROOT itself or beneath it. */
export function folderWithin(root, sub) {
  return sub ? `${root}/${sub}` : root;
}

/** Where `folder` sits in the link to `root`: '' for the root, 'a/b' beneath it, null when outside. */
export function relativeTo(root, folder) {
  const f = String(folder ?? '');
  if (f === root) return '';
  return f.startsWith(`${root}/`) ? f.slice(root.length + 1) : null;
}

/**
 * The trail from the link's folder down to `sub`: [{ sub, name }], the link's
 * folder first. Never above it — the link's folder is where the trail
 * begins, whatever holds it in the workspace.
 */
export function linkCrumbs(root, sub = '') {
  const name = root.slice(root.lastIndexOf('/') + 1);
  const parts = sub ? sub.split('/') : [];
  return [
    { sub: '', name },
    ...parts.map((p, i) => ({ sub: parts.slice(0, i + 1).join('/'), name: p })),
  ];
}

/** The page of one folder of the link: the link itself, or ?path= below it. */
export function linkFolderHref(token, sub = '') {
  const base = `/s/${encodeURIComponent(token)}`;
  return sub ? `${base}?${new URLSearchParams({ path: sub })}` : base;
}

/** A file's page under the link (its download is this, then /download). */
export function linkFileHref(token, id) {
  return `/s/${encodeURIComponent(token)}/files/${encodeURIComponent(id)}`;
}

/** What a file id from a request can look like before it is looked up. */
export function isLinkFileId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/**
 * The scope a folder link reaches, from its stored row and the drives there
 * are now — or { state } when it reaches nothing:
 *
 *   missing  not a link to a folder that could be served: a private one (a
 *            folder link is public or password-protected), or a root that is
 *            not a folder path
 *   gone     a drive's link whose drive is gone (deleted, or moved to another
 *            folder in the bucket): its files are the library's now, or
 *            nobody's, and the link was the drive's
 *   blocked  the folder is in a drive that no longer allows links of this kind
 *
 * `drives` are every drive, { prefix, shareKinds } (lib/db.js loadDriveGrants);
 * `libraryPrefix` the storage config's prefix. Returns { root, prefix,
 * library, tag, kind, exclude }: `exclude` the prefixes of drives whose files
 * the link never reaches — for the library, every drive; for a drive, those
 * inside it that do not allow the link's kind.
 */
export function folderLinkScope({ row, drives = [], libraryPrefix = 'files' } = {}) {
  if (!row || (row.kind || 'file') !== 'folder') return { state: 'missing' };
  if ((row.mode || 'public') === 'private') return { state: 'missing' };
  const root = storedRoot(row.folder);
  if (!root) return { state: 'missing' };
  const kind = row.password_hash ? 'password' : 'public';
  const all = (Array.isArray(drives) ? drives : []).filter((d) => clean(d?.prefix));
  const blocked = all.filter((d) => Array.isArray(d.shareKinds) && !d.shareKinds.includes(kind));
  const sp = row.storage_prefix != null ? cleanFolder(row.storage_prefix) : '';
  if (sp) {
    if (!all.some((d) => cleanFolder(d.prefix) === sp)) return { state: 'gone' };
    if (drivesHolding(`${sp}/${root}/`, blocked).length) return { state: 'blocked' };
    return { root, prefix: sp, library: false, tag: sp, kind, exclude: blocked.map((d) => clean(d.prefix)) };
  }
  const lp = cleanFolder(libraryPrefix || 'files') || 'files';
  return { root, prefix: lp, library: true, tag: '', kind, exclude: all.map((d) => clean(d.prefix)) };
}

/**
 * Whether one (already loaded) file is in the link — the rule above, for a
 * row a route is about to hand out. The queries apply the same rule; this
 * is the second look a download or a preview takes at the one row it got.
 */
export function fileInLink(file, scope) {
  if (!file || !scope?.root || !scope.prefix) return false;
  if (file.deletedAt) return false;
  if (file.storage !== 's3' || !file.storageKey) return false;
  if (file.visibility !== 'org') return false;
  const folder = String(file.folder ?? '');
  if (relativeTo(scope.root, folder) == null) return false;
  const key = String(file.storageKey);
  if (RESERVED_SEGMENT.test(folder) || RESERVED_SEGMENT.test(key)) return false;
  if (THUMB_ARTIFACT.test(key) || SYSTEM_KEY.test(key)) return false;
  const at = `${scope.prefix}/${folder}/`;
  if (!key.startsWith(at)) return false;
  const name = key.slice(at.length);
  if (!name || name.includes('/')) return false;
  for (const p of scope.exclude || []) if (p && key.startsWith(`${p}/`)) return false;
  return true;
}

// ── The queries ───────────────────────────────────────────────────────────
// Text and parameters, as lib/file-query.js builds them: every value is a
// $n placeholder, nothing from a request is ever in the text.

/**
 * Keys under `<prefix>/<folder>/`, as a byte-wise range: from 'x/' up to, not
 * including, 'x0' ('0' is the byte after '/') is exactly the keys that begin
 * 'x/', whatever the collation — the text_pattern_ops operators
 * files_live_key_idx serves, as listDrivesWithUsage (lib/db.js) uses them.
 * This is what keeps a link's queries to its folder's rows rather than a
 * scan of the library.
 */
function keysUnder(prefix, folder, push) {
  return [
    `f.storage_key ~>=~ ${push(`${prefix}/${folder}/`)}::text`,
    `f.storage_key ~<~ ${push(`${prefix}/${folder}0`)}::text`,
  ];
}

/** The WHERE terms every row of the link meets (the rule at the top). */
function linkClauses(scope, push) {
  if (!scope?.root || !scope.prefix) throw new Error('folder link: no scope');
  const p = push(scope.prefix);
  const where = [
    'f.deleted_at IS NULL',
    `f.storage = 's3'`,
    'f.storage_key IS NOT NULL',
    `f.visibility = 'org'`,
    ...artifactClauses(push),
    `f.folder !~* ${push(RESERVED_SEGMENT_RE)}`,
    `f.storage_key !~* ${push(RESERVED_SEGMENT_RE)}`,
    // Within the link's folder, by key.
    ...keysUnder(scope.prefix, scope.root, push),
    // <prefix>/<folder>/<name>, name one segment long: the key spells the
    // row's own folder. char_length throughout, as substr counts characters.
    `starts_with(f.storage_key, ${p}::text || '/' || f.folder || '/')`,
    `strpos(substr(f.storage_key, char_length(${p}::text) + char_length(f.folder) + 3), '/') = 0`,
    `char_length(f.storage_key) > char_length(${p}::text) + char_length(f.folder) + 2`,
  ];
  const exclude = (scope.exclude || []).map(clean).filter(Boolean).map((d) => `${likeLiteral(d)}/%`);
  if (exclude.length) where.push(`NOT (f.storage_key LIKE ANY(${push(exclude)}::text[]))`);
  return where;
}

/** A folder of the link, or a refusal to ask about any other. */
function within(scope, at) {
  if (typeof at !== 'string' || relativeTo(scope?.root ?? '', at) == null) throw new Error('folder link: outside the folder');
  return at;
}

/** The row's folder is `at` itself (whole segments: `at` is a folder path, compared exactly). */
function atFolder(scope, at, push) {
  within(scope, at);
  const keys = at === scope.root ? [] : keysUnder(scope.prefix, at, push);
  return [`f.folder = ${push(at)}`, ...keys];
}

/** The row's folder is somewhere strictly beneath `at`. */
function belowFolder(scope, at, push) {
  within(scope, at);
  return [`starts_with(f.folder, ${push(`${at}/`)})`, ...keysUnder(scope.prefix, at, push)];
}

/** The row's folder is the link's own or anywhere beneath it. */
function inLinkFolder(scope, push) {
  return `(f.folder = ${push(scope.root)} OR starts_with(f.folder, ${push(`${scope.root}/`)}))`;
}

const columns = () => FILE_COLUMNS.split(', ').map((c) => `f.${c}`).join(', ');
const pageSize = (limit) => {
  const n = Number(limit);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), LINK_PAGE_MAX) : LINK_PAGE;
};

/**
 * One page of the files directly in `at` (a folder within the link), by name
 * then id — keyset-paged like the Files listing, so the thousandth page costs
 * what the first does. `cursor` is { value: name, id } from the last row.
 */
export function buildLinkFilesQuery({ scope, at, cursor = null, limit = LINK_PAGE } = {}) {
  const params = [];
  const push = (v) => `$${params.push(v)}`;
  const where = [...linkClauses(scope, push), ...atFolder(scope, at, push)];
  if (cursor && cursor.id != null && typeof cursor.value === 'string') {
    where.push(`(f.name, f.id) > (${push(cursor.value)}::text, ${push(String(cursor.id))}::text)`);
  }
  const n = pageSize(limit);
  const text = `SELECT ${columns()}
FROM files f
WHERE ${where.join('\n  AND ')}
ORDER BY f.name ASC, f.id ASC
LIMIT ${push(n)}`;
  return { text, params, limit: n };
}

/** How many files are directly in `at`. */
export function buildLinkCountQuery({ scope, at } = {}) {
  const params = [];
  const push = (v) => `$${params.push(v)}`;
  const where = [...linkClauses(scope, push), ...atFolder(scope, at, push)];
  return { text: `SELECT count(*)::int AS n FROM files f WHERE ${where.join('\n  AND ')}`, params };
}

/**
 * The folders directly inside `at` that hold something the link reaches,
 * with how many files each holds, all the way down: { name, n }. Taken from
 * the files, not the folder rows — an empty folder, or one holding only
 * files restricted to certain people, is not shown.
 */
export function buildLinkFoldersQuery({ scope, at, limit = LINK_FOLDERS_MAX } = {}) {
  const params = [];
  const push = (v) => `$${params.push(v)}`;
  within(scope, at);
  const where = [...linkClauses(scope, push), ...belowFolder(scope, at, push)];
  const n = Math.max(1, Math.min(Number(limit) || LINK_FOLDERS_MAX, LINK_FOLDERS_MAX));
  const text = `SELECT c.name, count(*)::int AS n FROM (
  SELECT split_part(substr(f.folder, char_length(${push(at)}::text) + 2), '/', 1) AS name
  FROM files f
  WHERE ${where.join('\n    AND ')}
) c
WHERE c.name <> ''
GROUP BY c.name
ORDER BY c.name ASC
LIMIT ${push(n)}`;
  return { text, params };
}

/** One file by id, only if it is in the link — anywhere beneath its folder. */
export function buildLinkFileQuery({ scope, id } = {}) {
  const params = [];
  const push = (v) => `$${params.push(v)}`;
  const where = [`f.id = ${push(String(id))}`, ...linkClauses(scope, push), inLinkFolder(scope, push)];
  return { text: `SELECT ${columns()} FROM files f WHERE ${where.join('\n  AND ')} LIMIT 1`, params };
}

/** Whether the link reaches any file at all. */
export function buildLinkAnyQuery({ scope } = {}) {
  const params = [];
  const push = (v) => `$${params.push(v)}`;
  const where = [...linkClauses(scope, push), inLinkFolder(scope, push)];
  return { text: `SELECT EXISTS (SELECT 1 FROM files f WHERE ${where.join('\n  AND ')}) AS any`, params };
}

/**
 * A file as a folder link's grid hands it to a browser: what a card draws
 * (sharedFile, less the viewers' addresses), with the original only where a
 * card would draw it — a small picture with no preview of its own. Every
 * other file is opened, and downloaded, through the link's own routes, which
 * decide again; a listing need not hand out a signed original for each.
 */
export function linkTile(file) {
  const out = sharedFile(file);
  if (!out) return out;
  delete out.posterUrl;
  delete out.proxyUrl;
  delete out.proxyStatus;
  delete out.filmstripUrl;
  if (out.thumbnailUrl || !smallOriginal(file, 'card')) delete out.url;
  return out;
}
