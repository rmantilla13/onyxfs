/**
 * A trashed file's bytes, moved aside after the fact.
 *
 * Deleting a file used to move its object to `_trash/<id>/<key>` before it
 * answered: a server-side copy of the whole object. For a video of a few
 * gigabytes that kept the delete — and the person, and Finder — waiting, and
 * past 5 GB (CopyObject's ceiling) S3 refuses the copy, so those deletes
 * failed. Now a delete only marks the row (softDeleteFile, trash_key NULL):
 * the file leaves every listing and device at once, and its object stays at
 * its key a little longer — a state restore (nothing to move back) and the
 * purge (purgeTarget: the object at its own key, unless another row shares
 * it) have always handled, for rows trashed before trash_key existed.
 *
 * The object then moves here:
 *
 *   - in the background of the delete that trashed it (afterResponse);
 *   - when an upload wants its key (vacateTrashedKey), so a file put back
 *     under the same name — Finder's Replace deletes and then copies — keeps
 *     its name instead of becoming "name (2)", which is what s3UniqueKey
 *     makes of a key whose object still exists;
 *   - by the daily maintenance, for any a background move did not finish
 *     (moveLeftoverTrash).
 *
 * Nothing is lost on the way. The copy lands first; the row is pointed at it
 * only while it is still trashed, unmoved, at the same key — one UPDATE
 * (setTrashKeyIfUnmoved); only then is the original deleted. A restore in
 * between wins: the row is live again with its object where it always was,
 * and the copy is dropped. Two movers at once copy to the same key, and only
 * one UPDATE succeeds; the other sees the row already pointing at the copy
 * and leaves it.
 *
 * An object past MOVE_MAX_BYTES stays where it is until the purge: moving it
 * is a multipart copy of many gigabytes, for bytes that are deleted anyway.
 */
import {
  getFileById, storageKeyInUse, setTrashKeyIfUnmoved, trashedRowAtKey, listUnmovedTrash,
} from './db.js';
import { getStorageConfig, storageForKey, s3CopyObject, s3DeleteObject } from './storage.js';

export const TRASH_PREFIX = '_trash';

/** CopyObject's own ceiling: past it S3 wants a multipart copy. */
export const MOVE_MAX_BYTES = 5 * 1024 * 1024 * 1024;

/** Where a trashed file's object goes: under its id, so two files of one name never meet. */
export const trashKeyFor = (id, storageKey) => `${TRASH_PREFIX}/${id}/${storageKey}`;

const REAL = {
  getFileById, storageKeyInUse, setTrashKeyIfUnmoved, trashedRowAtKey, listUnmovedTrash,
  getStorageConfig, storageForKey, s3CopyObject, s3DeleteObject,
};

/**
 * Why a trashed row's object stays where it is, or null when it should move.
 * Pure: the decision, apart from the one question (another row sharing the
 * object) that needs the database.
 */
export function moveBlocker(row) {
  if (!row) return 'missing';
  if (!row.deletedAt) return 'live';
  if (row.trashKey) return 'moved';
  if (row.storage !== 's3' || !row.storageKey) return 'not-in-bucket';
  if (Number(row.size) > MOVE_MAX_BYTES) return 'too-large';
  return null;
}

/**
 * Move a trashed file's object to its trash key. → 'moved', or why not:
 * 'missing', 'live' (restored), 'moved' (already), 'not-in-bucket',
 * 'too-large', 'shared' (another row's object too, left alone as the delete
 * always has), 'restored' (restored while it was copied; the copy is gone),
 * 'unknown' (another write won and the row could not be read after; the copy
 * is kept).
 * Throws when storage does; the row is untouched then, and the move is
 * simply tried again later.
 *
 * `cfg` is the bucket the object is in, when the caller knows it (a drive's
 * own); otherwise it is worked out from the key, as the delete does.
 */
export async function moveTrashedObject(id, { cfg = null, deps = REAL } = {}) {
  const row = await deps.getFileById(id);
  const blocked = moveBlocker(row);
  if (blocked) return blocked;
  if (await deps.storageKeyInUse(row.storageKey, { exceptId: row.id })) return 'shared';

  const bucket = cfg || await deps.storageForKey(await deps.getStorageConfig(), row.storageKey);
  const target = trashKeyFor(row.id, row.storageKey);
  await deps.s3CopyObject(bucket, row.storageKey, target);
  if (await deps.setTrashKeyIfUnmoved(row.id, { trashKey: target, storageKey: row.storageKey })) {
    await deps.s3DeleteObject(bucket, row.storageKey);
    return 'moved';
  }
  // Someone else's UPDATE won. Another mover's — the row points at this very
  // copy, which is then its object — or a restore's, when the copy is ours
  // alone to remove. Unsure (the row could not be read), the copy stays: a
  // stray object in the trash, rather than the only one gone.
  const now = await deps.getFileById(row.id);
  if (!now) return 'unknown';
  if (now.trashKey === target) return 'moved';
  await deps.s3DeleteObject(bucket, target);
  return 'restored';
}

/**
 * Free `key` for an upload that wants it: a trashed file whose object is
 * still there has it moved to the trash first. Within `budgetMs`, then the
 * upload goes ahead whatever came of it — an object still in the way only
 * means the new file is named "name (2)", as it would have been anyway.
 * Never throws: the upload must not fail because the trash could not move.
 */
export async function vacateTrashedKey(cfg, key, { budgetMs = 20_000, deps = REAL } = {}) {
  if (!key) return 'none';
  try {
    const row = await deps.trashedRowAtKey(key);
    if (!row) return 'none';
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve('late'), budgetMs); });
    const moving = moveTrashedObject(row.id, { cfg, deps }).catch((e) => {
      console.warn('[trash] could not move', row.id, 'out of the way:', e.message);
      return 'failed';
    });
    try {
      return await Promise.race([moving, late]);
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.warn('[trash] could not check', key, e.message);
    return 'failed';
  }
}

/**
 * The daily sweep: trashed files whose object never moved (a background move
 * cut short, a key never wanted again), oldest first, until `budgetMs` is
 * spent. → how many moved.
 */
export async function moveLeftoverTrash({ budgetMs = 40_000, limit = 200, deps = REAL } = {}) {
  const started = Date.now();
  let moved = 0;
  for (const row of await deps.listUnmovedTrash({ limit, maxBytes: MOVE_MAX_BYTES })) {
    if (Date.now() - started > budgetMs) break;
    try {
      if (await moveTrashedObject(row.id, { deps }) === 'moved') moved++;
    } catch (e) {
      console.warn('[trash] leftover move failed for', row.id, e.message);
    }
  }
  return moved;
}
