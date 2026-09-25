// lib/folder-ops.js — the pure half of folder create / rename / move / delete.
//
// No database, no SDK: what a folder path may be, which stored objects a
// rename has to re-key and to where, and a small bounded-concurrency map. The
// route (app/api/files/folders/route.js) does the I/O around these, and the
// tests pin them down without either.

// Top-level prefixes the app keeps for itself. An object key containing one
// of these as a segment is read as a thumbnail or a trashed file rather than
// a user's file (see storage.isThumbnailKey), so no folder may be named so.
const RESERVED = new Set(['_thumbs', '_trash']);

/** A folder path normalized: trimmed segments, no empty ones, no edge slashes. */
export function cleanFolder(path) {
  return String(path || '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('/');
}

/** The parent of a folder path; '' for a top-level folder. */
export function parentOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** The last segment of a folder path. */
export function baseName(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * What a folder holds, from the folder list the files page already has
 * (listFileFolders: every path with its DIRECT file count). No request, and
 * nothing a viewer cannot already see — the summary route that counts a
 * subtree is a write check, because it is what a delete confirmation reads.
 *
 * { files: directly inside, total: in it and everything under it,
 *   subfolders: direct children, nested: every folder beneath it }.
 * For the root ('') `files` is null: loose top-level files are not folders
 * and the list does not count them.
 */
export function folderStats(folders, path) {
  const at = cleanFolder(path);
  let files = at ? 0 : null;
  let total = 0;
  let subfolders = 0;
  let nested = 0;
  for (const f of folders || []) {
    const p = f.folder || '';
    if (!p) continue;
    const n = Number(f.count) || 0;
    if (p === at) { files = n; total += n; continue; }
    if (at && !p.startsWith(`${at}/`)) continue;
    total += n;
    nested += 1;
    if (parentOf(p) === at) subfolders += 1;
  }
  return { files, total, subfolders, nested };
}

/**
 * The breadcrumb trail for a folder: the library root, then each ancestor,
 * then the folder itself — [{ path, name }], root first. Every entry but the
 * last is somewhere a click can go back to.
 */
export function crumbsFor(path, rootName = 'All files') {
  const parts = cleanFolder(path).split('/').filter(Boolean);
  return [
    { path: '', name: rootName },
    ...parts.map((name, i) => ({ path: parts.slice(0, i + 1).join('/'), name })),
  ];
}

/**
 * A drive's name as its folder in the bucket: "Brand Assets (2026)" →
 * "brand-assets-2026". Lowercase ASCII, digits and hyphens, so the prefix
 * reads the same in every S3 console and mounts cleanly on every OS.
 */
export function drivePrefixFor(name) {
  return String(name || '').trim().toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

/**
 * Why `name` cannot be a single folder name, or null when it can. One segment:
 * a slash would silently make a nested folder of a rename.
 */
export function folderNameProblem(name) {
  const s = String(name ?? '').trim();
  if (!s) return 'Enter a folder name.';
  if (s.includes('/')) return 'A folder name cannot contain “/”.';
  if (s === '.' || s === '..') return 'That name is reserved.';
  if (RESERVED.has(s.toLowerCase())) return `“${s}” is reserved for the app’s own files.`;
  if (s.length > 200) return 'Keep folder names under 200 characters.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return 'A folder name cannot contain control characters.';
  return null;
}

/**
 * Why a file name can't be used, or null. The name becomes the last segment
 * of the object key, so the same rules as a folder segment apply, with room
 * for S3's 1024-byte key limit left to the folder path.
 */
export function fileNameProblem(name) {
  const s = String(name ?? '').trim();
  if (!s) return 'Enter a file name.';
  if (s.includes('/')) return 'A file name cannot contain “/”.';
  if (s === '.' || s === '..') return 'That name is reserved.';
  if (s.length > 255) return 'Keep file names under 255 characters.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return 'A file name cannot contain control characters.';
  return null;
}

/** folderNameProblem for every segment of a path. */
export function folderPathProblem(path) {
  const clean = cleanFolder(path);
  if (!clean) return 'Enter a folder name.';
  for (const seg of clean.split('/')) {
    const p = folderNameProblem(seg);
    if (p) return p;
  }
  return null;
}

/** `path` is `folder` itself or somewhere beneath it. */
export function isWithin(path, folder) {
  return path === folder || path.startsWith(`${folder}/`);
}

/** `path` (within `from`) rewritten to sit at the same place under `to`. */
export function rebase(path, from, to) {
  if (path === from) return to;
  return `${to}${path.slice(from.length)}`;
}

/**
 * Escape LIKE's wildcards. `_` matches any character, so a folder named
 * "a_b" would otherwise also take in "axb/…" in a subtree query.
 */
export function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * The key an S3 file in `folder` has under `prefix`: `<prefix>/<folder>/<name>`,
 * the layout storage.buildObjectKey writes.
 */
export function keyFor(prefix, folder, name) {
  return [cleanFolder(prefix), cleanFolder(folder), name].filter(Boolean).join('/');
}

/**
 * What renaming `from` to `to` does to the files under it, within one storage
 * scope (a filespace's prefix, or the base prefix for the unscoped library).
 *
 * `files` are rows under `from`: { id, folder, storage, storageKey }. Each one
 * lands in exactly one list:
 *
 *   moves   S3 objects in this scope: { id, folder, fromKey, toKey }
 *   catalog files with nothing in a bucket to move (Blob storage, or an S3
 *           row with no key): { id, folder } — only in the unscoped library
 *   outside files in the same folder path but another scope — another
 *           filespace's prefix, or a key that does not follow the layout.
 *           Left exactly where they are: re-keying them with this scope's
 *           prefix would point them at objects that do not exist.
 */
export function planRename({ from, to, prefix, scoped, files }) {
  const moves = [];
  const catalog = [];
  const outside = [];
  for (const f of files) {
    if (!isWithin(f.folder || '', from)) continue;
    const folder = rebase(f.folder, from, to);
    if (f.storage === 's3' && f.storageKey) {
      const name = baseName(f.storageKey);
      if (f.storageKey !== keyFor(prefix, f.folder, name)) { outside.push(f.id); continue; }
      moves.push({ id: f.id, folder, fromKey: f.storageKey, toKey: keyFor(prefix, folder, name) });
    } else if (!scoped) {
      catalog.push({ id: f.id, folder });
    } else {
      outside.push(f.id);
    }
  }
  return { moves, catalog, outside };
}

/** Map `items` through async `fn`, at most `limit` at a time. Rejects on the first failure after in-flight calls settle. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      const i = next++;
      try { results[i] = await fn(items[i], i); }
      catch (e) { failure ||= e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure;
  return results;
}

/** Like mapLimit, but never rejects: { ok, value } | { ok: false, error } per item. */
export function settleLimit(items, limit, fn) {
  return mapLimit(items, limit, async (item, i) => {
    try { return { ok: true, value: await fn(item, i) }; }
    catch (error) { return { ok: false, error }; }
  });
}
