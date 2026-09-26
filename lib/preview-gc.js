// lib/preview-gc.js — deleting the previews nothing points at any more.
//
// A file's previews (its grid thumbnail and that thumbnail's sm/xs siblings,
// its player poster or large image preview, its hover-scrub strip) live under
// `_thumbs/`, named by the presign route, and are reachable only through the
// row that records them. When the row goes — a delete with the trash off, a
// trashed row purged, a folder deleted — or points at new ones, the old
// objects would otherwise stay in the bucket for good, reachable by nothing.
//
// Only server-named keys are ever candidates (isThumbKey, isPosterKey,
// isFilmstripKey): never a legacy thumbnail stored beside the files, never a
// file. And only once no row points at them: a row written before keys were
// checked may share one (lib/db.js previewKeysInUse), and a trashed row still
// holds its previews for a restore. Best-effort throughout — a preview left
// behind costs a few kilobytes; a failed delete must not fail the request.

import { unreferencedPreviewKeys, previewKeysInUse } from './db.js';
import { getStorageConfig, storageMode, s3DeleteObject } from './storage.js';
import { isThumbKey, isPosterKey, isFilmstripKey, thumbSiblingKey, THUMB_SIZES } from './media.js';

/** The server-named preview keys these rows point at, by column. */
export function previewKeysOf(files = []) {
  const list = Array.isArray(files) ? files : [files];
  return {
    thumbKeys: list.map((f) => f?.thumbnailKey).filter(isThumbKey),
    posterKeys: list.map((f) => f?.posterKey).filter(isPosterKey),
    stripKeys: list.map((f) => f?.filmstripKey).filter(isFilmstripKey),
  };
}

/**
 * The objects to delete for these unused preview keys: each key, and each
 * thumbnail's siblings with it — they share its uuid, and nothing can point
 * at them except through it.
 */
export function previewObjects(unused = []) {
  const keys = unused.filter((k) => isThumbKey(k) || isPosterKey(k) || isFilmstripKey(k));
  const siblings = keys.filter(isThumbKey).flatMap((k) => THUMB_SIZES.map((size) => thumbSiblingKey(k, size))).filter(Boolean);
  return [...new Set([...keys, ...siblings])];
}

/**
 * Delete whichever of these previews no row points at any more, with a
 * thumbnail's siblings. Resolves how many objects were deleted; never throws.
 * `remove(key)` replaces the bucket delete (tests).
 */
export async function dropUnusedPreviews({ thumbKeys = [], posterKeys = [], stripKeys = [] } = {}, { cfg = null, remove = null } = {}) {
  try {
    const unused = await unreferencedPreviewKeys({ thumbKeys, posterKeys });
    let strips = [];
    const wanted = [...new Set(stripKeys.filter(isFilmstripKey))];
    if (wanted.length) {
      // Throws when it cannot tell; then nothing is deleted.
      try {
        const inUse = await previewKeysInUse(wanted);
        strips = wanted.filter((k) => !inUse.has(k));
      } catch { strips = []; }
    }
    const objects = previewObjects([...unused, ...strips]);
    if (!objects.length) return 0;
    let del = remove;
    if (!del) {
      const c = cfg || (await getStorageConfig());
      if (storageMode(c) !== 's3') return 0;
      del = (key) => s3DeleteObject(c, key);
    }
    const done = await Promise.all(objects.map((key) => Promise.resolve().then(() => del(key)).catch(() => false)));
    return done.filter(Boolean).length;
  } catch (e) {
    console.warn('[preview-gc] could not remove unused previews:', e.message);
    return 0;
  }
}
