// lib/replace-content.js — new contents for a file already in the library:
// the same id, name, folder, comments and links, new bytes. What a save over
// a file in Finder becomes (Onyx for Mac), and what the web can use later.
// Node only: it reads the database and the bucket.
//
// It is built inside the upload machinery, not beside it. The new bytes go
// up like any upload — presign, or multipart for a large file — asked for
// with `replaceOf: <file id>`. They land beside the old bytes, in the file's
// own folder of its own drive, under a key issued to this person for new
// contents of this file and for nothing else (lib/db.js issueUploadKey).
// Then POST /api/files/[id]/content swaps them in, in one conditional UPDATE
// (replaceFileContent). Until that commits the file is exactly what it was:
// nothing is ever written over the old object, so an upload that fails, is
// abandoned or is refused changes nothing anyone can see.
//
// Onyx keeps no versions yet. Once the swap commits the old object is
// deleted — unless another row still names it — and the previews go too,
// to be made again from the new bytes. A transcript is left to read as
// stale, which it now is.

import { NextResponse } from 'next/server';
import { getFileById, canModifyFile, loadDriveGrants, getFilespaceForWrite, storageKeyInUse } from './db.js';
import { getStorageConfig, storageMode, cfgForFilespace, s3ObjectExists, safeObjectName } from './storage.js';
import { can, refusal } from './authz.js';
import { drivesHolding } from './drive-access.js';

const fail = (status, error, code) => ({ error: NextResponse.json({ error, ...(code ? { code } : {}) }, { status }) });
const clean = (p) => String(p || '').replace(/^\/+|\/+$/g, '');

/** The folder part of an object key, with its slash: 'team/Cuts/a.mov' → 'team/Cuts/'. */
export function dirOf(key) {
  const k = String(key || '');
  return k.slice(0, k.lastIndexOf('/') + 1);
}

/**
 * The drive a key sits in that this principal may write to, innermost first
 * (a drive inside another is in both): → { fs } with its bucket and keys,
 * { fs: null } for a key in no drive, or { denied } for a drive they may
 * only view. From the key, never the request: the file's own drive.
 */
async function writableDriveFor(principal, key) {
  const drives = principal.driveScope?.drives || (await loadDriveGrants(principal.email)).drives;
  const holding = drivesHolding(key, drives).sort((a, b) => clean(b.prefix).length - clean(a.prefix).length);
  if (!holding.length) return { fs: null };
  for (const d of holding) {
    const fs = await getFilespaceForWrite(principal.email, d.id, principal);
    if (fs) return { fs };
  }
  return { denied: true };
}

/**
 * May `principal` put new contents in file `id`, and where do they go?
 * → { file, cfg, base, filespaceId } or { error: Response }.
 *
 * The bar every other change to a file has: files.edit, write access to this
 * file (canModifyFile — its drive, its creator, a grant) and, for a file in
 * a drive, write access to the drive, since the new bytes land under its
 * prefix (getFilespaceForWrite). How big they may be is uploadCheck's, with
 * `replaces`, once the caller knows the size. `cfg` is the bucket the file
 * lives in; `base` the deployment's, where previews live.
 */
export async function replacementTarget(principal, id) {
  const edit = can(principal, 'files.edit');
  if (!edit.ok) return { error: await refusal(edit) };
  const file = id ? await getFileById(String(id)) : null;
  // A trashed file is gone until it is restored, as everywhere else.
  if (!file || file.deletedAt) return fail(404, 'File not found');
  // As PATCH and DELETE answer it: the same words whether or not they can see it.
  if (!(await canModifyFile(file, principal))) return fail(403, 'No access');
  if (file.storage !== 's3' || !file.storageKey) {
    return fail(409, 'This file is not stored in the bucket, so its contents cannot be replaced. Upload it as a new file.', 'not_s3');
  }
  const base = await getStorageConfig();
  if (storageMode(base) !== 's3') return fail(400, 'No custom bucket configured.', 'no_bucket');
  const drive = await writableDriveFor(principal, file.storageKey);
  if (drive.denied) return fail(403, 'You can view this drive but not change it. Ask one of its owners for editor access.');
  return { file, cfg: drive.fs ? cfgForFilespace(base, drive.fs) : base, base, filespaceId: drive.fs?.id || null };
}

/**
 * A fresh key for a file's new contents: in the old object's folder, named
 * as an upload of the file's name would be — the name itself when that is
 * free (it is not, while the old bytes sit there), else " (2)", " (3)"… as
 * s3UniqueKey counts. So the bucket keeps reading like the library, and a
 * file replaced twice is back under its own name. A key another row names is
 * passed over too: a trashed file keeps its old key to be restored to.
 */
export async function replacementKey(cfg, file) {
  const dir = dirOf(file.storageKey);
  const name = safeObjectName(file.name);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; n < 50; n++) {
    const key = `${dir}${n === 1 ? name : `${stem} (${n})${ext}`}`;
    if (key === file.storageKey) continue;
    if (await s3ObjectExists(cfg, key)) continue;
    if (await storageKeyInUse(key)) continue;
    return key;
  }
  return `${dir}${stem} (${Date.now()})${ext}`;
}
