// lib/library-move.js — the pure half of moving the files outside every drive
// into one (POST /api/admin/library/move, Admin → Usage's "Move into a
// drive…").
//
// With no All files (the `library` flag, off by default) a file stored under
// no drive's prefix is out of everyone's sight until it is in a drive. The
// route moves them there the way a folder rename moves a tree: each object is
// copied to the key an upload into the drive would get, noted first
// (folder_move_copies), the row pointed at the copy, and only then the
// original deleted. These are the decisions around that I/O — where the bytes
// can go, where each file lands and what it is called there, what an earlier
// call left part-way — so the tests pin them down without a bucket.

import { cleanFolder, nfc, isAscii, respellPath } from './folder-ops.js';
import { LIMITS, sameName } from './collections.js';

/**
 * Who holds the keys the move is copying to (lib/db.js issueUploadKey), until
 * each file's row does. Not an email, so never a person: an upload by anyone
 * — the admin running the move included — is never handed one of these keys
 * (uploadKeyHeld shares a key only with the one it was issued to), and giving
 * one back never takes a person's own hold on that key with it.
 */
export const MOVE_HOLDER = 'library-move';

const endpointOf = (e) => {
  const s = String(e || '').trim().toLowerCase().replace(/\/+$/, '');
  return s && !/^[a-z][a-z0-9+.-]*:\/\//.test(s) ? `https://${s}` : s;
};

/**
 * How the files outside every drive — all in the Storage bucket — can reach
 * `drive`:
 *
 *   { mode: 'within' }  the Storage bucket itself, which the Storage keys
 *                       reach whatever keys the drive mounts with
 *   { mode: 'across' }  a bucket of its own on the same service, reached by
 *                       the same keys: copied bucket to bucket, server side
 *   { problem }         a bucket with keys of its own: another account,
 *                       perhaps another service, which the server could
 *                       reach only by downloading every file and uploading
 *                       it again. Said, rather than attempted.
 *
 * `base` is the Storage config; `drive` a filespace row, its secret present
 * (listDriveStorage, getFilespace) or only noted (`hasSecret`).
 *
 * Across, a bucket in another region than the Storage bucket's says so
 * (`warning`): every byte crosses between them, which the provider bills as
 * transfer, and a library of terabytes is a bill worth knowing of first.
 */
export function moveRoute(base, drive) {
  const name = drive?.name || 'That drive';
  if (!cleanFolder(drive?.prefix)) return { problem: `“${name}” has no folder in the bucket to move files into.` };
  const bucket = String(drive.bucket || '').trim() || String(base?.bucket || '').trim();
  const ownKeys = !!(drive.accessKeyId && (drive.secretAccessKey || drive.hasSecret));
  const sameBucket = bucket === String(base?.bucket || '').trim();
  const sameService = !ownKeys || endpointOf(drive.endpoint) === endpointOf(base?.endpoint);
  if (sameBucket && sameService) return { mode: 'within' };
  if (!ownKeys) {
    const region = (r) => { const s = String(r || '').trim().toLowerCase(); return s === 'auto' ? '' : s; };
    const from = region(base?.region);
    const to = region(drive.region);
    if (!from || !to || from === to) return { mode: 'across' };
    return {
      mode: 'across',
      warning: `“${name}” keeps its files in a bucket in ${to}, and these are in ${from}: every byte copied crosses between the two regions, which the provider bills as data transfer.`,
    };
  }
  return {
    problem: `“${name}” keeps its files in a bucket of its own, with keys of its own, and files can only be copied into it from there. Choose a drive in the Storage bucket.`,
  };
}

/** Where a file in `folder` lands under `under`, a folder in the drive ('' for its top). */
export function landingFolder(under, folder) {
  return [cleanFolder(under), cleanFolder(folder)].filter(Boolean).join('/');
}

/**
 * The folder in the drive a library path lands at, spelled as the drive
 * spells it: composed (NFC), then as a folder stored there already spells
 * it (`spellings`, lib/db.js folderSpellings; respellPath) — what
 * canonicalFolder makes of it, from spellings read once. Files land where
 * canonicalFolder puts them, so a folder row, a link or a star read with the
 * spellings after them lands on their folder, however the library stored
 * its name: never a decomposed "Café" beside the composed one its files are
 * in.
 */
export function landingPath(under, path, spellings = []) {
  const c = nfc(landingFolder(under, path));
  return !c || isAscii(c) ? c : respellPath(c, spellings);
}

/**
 * The drive `key` would be inside if it is not only the one moved into:
 * another drive whose prefix lies within `prefix` and holds `key` — a
 * client's drive nested in a team's, with members of its own. Its deepest,
 * or null. A file never lands there: its members never chose it, and the
 * admin chose another drive.
 */
export function insideAnother(key, { prefix, drives = [] } = {}) {
  const p = cleanFolder(prefix);
  const k = String(key || '');
  let found = null;
  for (const d of drives) {
    const c = cleanFolder(d?.prefix);
    if (!c || c === p || !c.startsWith(`${p}/`) || !k.startsWith(`${c}/`)) continue;
    if (!found || c.length > cleanFolder(found.prefix).length) found = d;
  }
  return found;
}

/**
 * The folders that still hold a file outside every drive, from those
 * files' own folders (lib/db.js foldersOutsideDrives): each, and every
 * folder above it, composed (NFC). A file inherits from its folder and the
 * ones above it (lib/collections.js), so each of these keeps its row in the
 * library while such a file is there.
 */
export function heldFolders(folders = []) {
  const held = new Set();
  for (const f of folders) {
    for (let p = nfc(cleanFolder(f)); p; p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') held.add(p);
  }
  return held;
}

/**
 * The library's folder rows grouped by where they land (`destOf`, a path
 * → its path in the drive, or null for one that stays): [{ dest, keep,
 * names, tags, metadata, copy }], for lib/db.js moveFoldersIntoDrive. Two
 * rows land on one path when the library has a name both composed and
 * decomposed; they become one, `keep` (the first by name) moved there,
 * with the tags of both and the metadata of both — the first's values
 * winning where both have one.
 *
 * `copy` when a file outside every drive is still in the folder or beneath
 * it (`held`, heldFolders): the drive's folder there takes on its tags and
 * metadata, and the library keeps its rows, so the files on both sides keep
 * what they inherit.
 */
export function folderLandings(rows = [], destOf, { held = new Set() } = {}) {
  const groups = new Map();
  for (const r of [...rows].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const dest = destOf(r.name);
    if (!dest) continue;
    const kept = held.has(nfc(cleanFolder(r.name)));
    const g = groups.get(dest);
    if (!g) {
      groups.set(dest, { dest, keep: r.name, names: [r.name], tags: [...(r.tags || [])], metadata: { ...(r.metadata || {}) }, copy: kept });
      continue;
    }
    g.names.push(r.name);
    for (const t of r.tags || []) if (!g.tags.includes(t)) g.tags.push(t);
    g.metadata = { ...(r.metadata || {}), ...g.metadata };
    g.copy ||= kept;
  }
  return [...groups.values()];
}

/**
 * Whether `key` is `wanted` or a name s3UniqueKey makes of it when that is
 * taken: in the same folder, " (2)", " (3)", … before the extension. A copy
 * an earlier call noted for a file is carried on from only then: one at
 * another name is of a file renamed since, and would undo the rename.
 */
export function isNameOf(key, wanted) {
  const k = String(key || '');
  const w = String(wanted || '');
  if (!k || !w) return false;
  if (k === w) return true;
  const slash = w.lastIndexOf('/');
  const dir = w.slice(0, slash + 1);
  const base = w.slice(slash + 1);
  if (!k.startsWith(dir) || k.indexOf('/', dir.length) !== -1) return false;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  const rest = k.slice(dir.length);
  if (!rest.startsWith(`${stem} (`) || !rest.endsWith(`)${ext}`)) return false;
  return /^\d+$/.test(rest.slice(stem.length + 2, rest.length - ext.length - 1));
}

const stemOf = (s) => { const d = s.lastIndexOf('.'); return d > 0 ? s.slice(0, d) : s; };
const extOf = (s) => { const d = s.lastIndexOf('.'); return d > 0 ? s.slice(d) : ''; };

/**
 * A file's name in the drive. The key an upload would get is `asked`
 * (safeObjectName of the name); `landed` is the one it got, " (2)" added
 * when that was taken (s3UniqueKey). Unchanged when it got the one asked
 * for; otherwise the same suffix on the file's own name, so the catalog
 * says what a mounted drive shows — "Café (2).jpg" for "Caf_ (2).jpg".
 */
export function landedName(name, asked, landed) {
  if (landed === asked) return name;
  if (name === asked) return landed;
  const a = stemOf(asked);
  const l = stemOf(landed);
  if (!l.startsWith(a) || extOf(asked) !== extOf(landed)) return landed;
  return `${stemOf(name)}${l.slice(a.length)}${extOf(name)}`;
}

/** Whether `key` is under none of `drivePrefixes`: outside every drive. */
export function isLooseKey(key, drivePrefixes = []) {
  const k = String(key || '');
  if (!k) return false;
  return !drivePrefixes.some((p) => {
    const c = cleanFolder(p);
    return c && k.startsWith(`${c}/`);
  });
}

/**
 * What to do with a copy an earlier call noted into the drive ({ toKey,
 * fromKey }), from which of the two keys a file now holds (`held`, a Set):
 *
 *   tidy    the file points at the copy, and nothing at the original: the
 *           call stopped before deleting it. Delete it, forget the note
 *   forget  both are held — the original by another file sharing it, or the
 *           copy by a file that came to it some other way. Keep both
 *   reuse   the file is still at the original: the call stopped after its
 *           copy. The file's move carries on from it
 *   orphan  neither: the file went (deleted, or its object to the trash) or
 *           moved by other means since. The copy is nobody's; delete it
 */
export function noteState({ toKey, fromKey }, held) {
  const to = held.has(toKey);
  const from = held.has(fromKey);
  if (to) return from ? 'forget' : 'tidy';
  return from ? 'reuse' : 'orphan';
}

/**
 * `name`, or the first of "name (2)", "name (3)", … that none of `taken`
 * is (compared as collection names are, sameName), kept to the longest a
 * collection name may be.
 */
export function freeName(name, taken = [], max = LIMITS.name) {
  const clash = (n) => taken.some((t) => sameName(t, n));
  if (!clash(name)) return name;
  for (let i = 2; ; i++) {
    const suffix = ` (${i})`;
    const n = `${String(name).slice(0, Math.max(1, max - suffix.length)).trimEnd()}${suffix}`;
    if (!clash(n)) return n;
  }
}

/**
 * The library's collections (driveId '', or `from`), moved into `driveId`:
 * [{ id, name }], each renamed only where the drive already has one of that
 * name — a drive's collection names are its own (POST /api/collections).
 */
export function collectionMoves(collections = [], { driveId, from = '' } = {}) {
  const taken = collections.filter((c) => (c.driveId || '') === driveId).map((c) => c.name);
  const out = [];
  for (const c of collections) {
    if ((c.driveId || '') !== from) continue;
    const name = freeName(c.name, taken);
    taken.push(name);
    out.push({ id: c.id, name });
  }
  return out;
}
