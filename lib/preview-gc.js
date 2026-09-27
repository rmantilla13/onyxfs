// lib/preview-gc.js — deleting the previews nothing points at any more.
//
// A file's previews (its grid thumbnail and that thumbnail's sm/xs siblings,
// its player poster or large image preview, its hover-scrub strip) live under
// `_thumbs/`, named by the presign route, and are reachable only through the
// row that records them. When the row goes — a delete with the trash off, a
// trashed row purged, a folder deleted — or points at new ones, the old
// objects would otherwise stay in the bucket for good, reachable by nothing.
//
// A proxy rendition goes the same way, and is the one that matters in bytes: a
// 4K master's proxy is hundreds of megabytes. Its key is not on the files row
// though — it is on the job row — so callers read it with lib/db.js
// proxyKeysFor BEFORE the purge that would delete that row.
//
// Only server-named keys are ever candidates (isThumbKey, isPosterKey,
// isFilmstripKey, isProxyKey): never a legacy thumbnail stored beside the
// files, never a file. And only once no row points at them: a row written before keys were
// checked may share one (lib/db.js previewKeysInUse), and a trashed row still
// holds its previews for a restore. Best-effort throughout — a preview left
// behind costs a few kilobytes; a failed delete must not fail the request.

import { unreferencedPreviewKeys, previewKeysInUse, proxyKeysInUse } from './db.js';
import { getStorageConfig, storageMode, s3DeleteObject } from './storage.js';
import { isThumbKey, isPosterKey, isFilmstripKey, isProxyKey, thumbSiblingKey, THUMB_SIZES } from './media.js';

/**
 * An upload's preview fields (uploadFields) without the keys in `taken` —
 * keys another row already holds (lib/db.js previewKeysInUse). A thumbnail
 * goes with its poster and its smaller siblings: they are the same picture,
 * and the siblings' keys are the thumbnail's. A filmstrip goes with its
 * geometry. Everything else is kept, so the upload is still recorded.
 */
export function withoutTakenPreviews(fields, taken) {
  if (!taken || !taken.size) return fields;
  const out = { ...fields };
  if (taken.has(out.thumbnailKey) || taken.has(out.posterKey)) {
    out.thumbnailKey = null;
    out.posterKey = null;
    out.thumbSizes = null;
  }
  if (taken.has(out.filmstripKey)) {
    out.filmstripKey = null;
    if (out.metadata?.filmstrip) {
      const { filmstrip: _drop, ...rest } = out.metadata;
      out.metadata = rest;
    }
  }
  return out;
}

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
  const keys = unused.filter((k) => isThumbKey(k) || isPosterKey(k) || isFilmstripKey(k) || isProxyKey(k));
  const siblings = keys.filter(isThumbKey).flatMap((k) => THUMB_SIZES.map((size) => thumbSiblingKey(k, size))).filter(Boolean);
  return [...new Set([...keys, ...siblings])];
}

/**
 * Delete whichever of these previews no row points at any more, with a
 * thumbnail's siblings. Resolves how many objects were deleted; never throws.
 * `remove(key)` replaces the bucket delete (tests).
 *
 * `proxyKeys` are proxy renditions (lib/proxies.js) — far bigger than a
 * thumbnail, so the one preview worth deleting promptly rather than eventually.
 */
export async function dropUnusedPreviews(
  { thumbKeys = [], posterKeys = [], stripKeys = [], proxyKeys = [] } = {},
  { cfg = null, remove = null } = {},
) {
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
    // A proxy rendition, which is not a column on `files` — its key lives on the
    // job row, so "does anything still point at this" is the `proxies` table's
    // question, not the listing's. Read from there BEFORE a purge
    // (lib/db.js proxyKeysFor), since deleting the row loses the key and the
    // object with it. Fails closed, as the strips do.
    let proxies = [];
    const askedProxies = [...new Set(proxyKeys.filter(isProxyKey))];
    if (askedProxies.length) {
      try {
        const inUse = await proxyKeysInUse(askedProxies);
        proxies = askedProxies.filter((k) => !inUse.has(k));
      } catch { proxies = []; }
    }
    const objects = previewObjects([...unused, ...strips, ...proxies]);
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
