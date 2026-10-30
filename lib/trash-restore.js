/**
 * Putting a trashed file back: the one way it is done, for Admin → Trash,
 * for anyone's own Trash (/trash) and for the Undo a delete offers.
 *
 * On S3 the object moves from its trash key back to the key it had — or,
 * when a newer file has taken that name in the meantime, to the next free
 * one ("a (2).jpg"), and the row is renamed to match, so the catalog says
 * what a mounted drive shows (landedName). A restore never overwrites
 * anything. Then restoreFile clears the trash flags and advances the
 * sequence, which is how synced devices learn it is back.
 *
 * The object goes to the trash after the delete has answered
 * (lib/trash-move.js), so a restore can land while it does. The row is
 * restored only if its trash_key is still the one this decided from: had the
 * mover pointed it at the copy in between, restoring it as "never moved"
 * would bring it back at a key the mover then empties. A miss reads the row
 * again and decides afresh — now from the copy, which moves back.
 */
import { getFileById, storageKeyInUse, restoreFile } from './db.js';
import { storageMode, storageForKey, s3ObjectExists, s3UniqueKey, s3MoveObject } from './storage.js';
import { landedName } from './library-move.js';
import { settleLimit } from './folder-ops.js';

const REAL = { getFileById, storageKeyInUse, restoreFile, storageForKey, s3ObjectExists, s3UniqueKey, s3MoveObject };

const baseOf = (key) => String(key || '').slice(String(key || '').lastIndexOf('/') + 1);

/**
 * Restore one trashed row. → { id, name, movedTo, restored }: `movedTo` is
 * the new key when its own was taken, `restored` false when it was not in
 * the trash by the time it was asked (purged, or restored by someone else).
 * Throws when storage does; nothing is changed then.
 */
export async function restoreTrashed(row, { cfg, deps = REAL } = {}) {
  let f = row;
  for (let attempt = 0; attempt < 3; attempt++) {
    let storageKey = null;
    let name = null;
    if (f.trashKey && f.storage === 's3') {
      if (storageMode(cfg) !== 's3') throw new Error('Storage is not configured for S3, so the stored file cannot be moved back.');
      // Back where it was trashed: a drive in a bucket of its own keeps its
      // trash there too.
      const own = await deps.storageForKey(cfg, f.storageKey);
      let target = f.storageKey;
      const taken = await deps.storageKeyInUse(target, { exceptId: f.id })
        || await deps.s3ObjectExists(own, target).catch(() => false);
      if (taken) target = await deps.s3UniqueKey(own, target);
      await deps.s3MoveObject(own, f.trashKey, target, { size: f.size });
      storageKey = target;
      if (target !== f.storageKey) name = landedName(f.name, baseOf(f.storageKey), baseOf(target));
    }
    const back = await deps.restoreFile(f.id, { storageKey, name, trashKey: f.trashKey ?? null });
    if (back) {
      return { id: f.id, name: back.name ?? name ?? f.name, movedTo: storageKey !== f.storageKey ? storageKey : null, restored: true };
    }
    const now = await deps.getFileById(f.id);
    if (!now || !now.deletedAt) return { id: f.id, name: f.name, movedTo: null, restored: false };
    if (storageKey) {
      // Its trash_key changed although the copy was there to move: nothing
      // but a restore or a purge changes it, and both are handled above. Say
      // where the bytes went rather than guess.
      console.warn(`[trash] ${f.id} changed while it was restored; its object is at ${storageKey}`);
      throw new Error('The file changed while it was being restored. Try again.');
    }
    // Moved to the trash meanwhile: decide again, from the copy.
    f = now;
  }
  throw new Error('The file kept changing while it was being restored. Try again.');
}

/**
 * Restore trashed rows, a few at a time. → { restored, failed }: `restored`
 * each row's answer (its `restored` false when it had left the trash by
 * then), `failed` [{ id, error }] for those storage refused.
 */
export async function restoreTrashedFiles(rows = [], { cfg, deps = REAL, concurrency = 8 } = {}) {
  const results = await settleLimit(rows, concurrency, (f) => restoreTrashed(f, { cfg, deps }));
  const restored = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.ok) restored.push(r.value);
    else failed.push({ id: rows[i].id, error: r.error?.message || 'Restore failed.' });
  });
  return { restored, failed };
}
