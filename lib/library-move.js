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

import { cleanFolder } from './folder-ops.js';
import { LIMITS, sameName } from './collections.js';

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
 */
export function moveRoute(base, drive) {
  const name = drive?.name || 'That drive';
  if (!cleanFolder(drive?.prefix)) return { problem: `“${name}” has no folder in the bucket to move files into.` };
  const bucket = String(drive.bucket || '').trim() || String(base?.bucket || '').trim();
  const ownKeys = !!(drive.accessKeyId && (drive.secretAccessKey || drive.hasSecret));
  const sameBucket = bucket === String(base?.bucket || '').trim();
  const sameService = !ownKeys || endpointOf(drive.endpoint) === endpointOf(base?.endpoint);
  if (sameBucket && sameService) return { mode: 'within' };
  if (!ownKeys) return { mode: 'across' };
  return {
    problem: `“${name}” keeps its files in a bucket of its own, with keys of its own, and files can only be copied into it from there. Choose a drive in the Storage bucket.`,
  };
}

/** Where a file in `folder` lands under `under`, a folder in the drive ('' for its top). */
export function landingFolder(under, folder) {
  return [cleanFolder(under), cleanFolder(folder)].filter(Boolean).join('/');
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
