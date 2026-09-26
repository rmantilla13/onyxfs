// lib/backfill.js — the thumbnail backfill, loaded when it is first needed.
//
// Most rows already have every preview they need, so the code that draws
// them (lib/thumbnail-client.js: decoding, canvases, encoders, uploads) is
// not part of the files page or the file page. The first tile that asks for
// something — a missing thumbnail, the siblings of an old one, a preview from
// an original a viewer just fetched — loads it; requests made meanwhile wait
// for it in order.
//
// What decides whether an original a viewer fetched is worth handing over
// (previewWanted) lives here too, so a viewer can ask before it downloads
// the original in the way the handover needs (CORS, never from the HTTP
// cache) rather than the way that is cheapest to show.

import { drawableKind, isThumbKey, THUMB_SOURCE_MAX_BYTES } from './media.js';
import { imagePreviewFor } from './poster.js';

// A file this browser tried and could not, or need not, make a preview for
// is not tried again for a week: a library of GIFs, small pictures or TIFFs
// must not re-download and re-draw every original on every visit.
const SKIP_PREFIX = 'onyx:thumb-skip:';
const SKIP_MS = 7 * 24 * 3600 * 1000;

/** Whether `id` was skipped (for `what`: '' for thumbnails, 'sizes', 'preview') in the last week, in this browser. */
export function skippedRecently(id, what = '') {
  try { return Date.now() - Number(localStorage.getItem(SKIP_PREFIX + (what ? `${what}:` : '') + id) || 0) < SKIP_MS; } catch { return false; }
}

/** Remember that `id` was skipped for `what`. */
export function rememberSkip(id, what = '') {
  try { localStorage.setItem(SKIP_PREFIX + (what ? `${what}:` : '') + id, String(Date.now())); } catch {}
}

/** The mime type to judge an image by: the row's, else a GIF by its name. */
export function imageMime(file) {
  return String(file?.mime || file?.type || (/\.gif$/i.test(file?.name || '') ? 'image/gif' : ''));
}

/**
 * Whether an original shown for `file` should go to the fill-in, to become
 * its large preview (lib/thumbnail-client.js). Not for a file that has a
 * preview, one this browser cannot draw or would not decode (too big), one
 * already skipped here — and not for one that by design gets none
 * (lib/poster.js imagePreviewFor: a GIF, a picture barely bigger than its
 * grid thumbnail, an original about the size a preview would be), which the
 * row's own width and height can tell before anything is downloaded. Without
 * them it is decided after the decode, once, and remembered.
 */
export function previewWanted(file, { probe } = {}) {
  if (!file?.id || file.storage !== 's3' || file.posterUrl || file.posterKey) return false;
  if (drawableKind(file, { probe }) !== 'image') return false;
  if (!(Number(file.size) > 0) || Number(file.size) > THUMB_SOURCE_MAX_BYTES) return false;
  // A file with no server-made thumbnail gets its whole set from the handover.
  if (!isThumbKey(file.thumbnailKey)) return !skippedRecently(file.id);
  if (skippedRecently(file.id, 'preview')) return false;
  const mime = imageMime(file);
  if (/gif/i.test(mime)) return false;
  const md = file.metadata || {};
  const w = Number(md.width);
  const h = Number(md.height);
  if (w > 0 && h > 0 && !imagePreviewFor({ width: w, height: h }, { bytes: file.size, mime })) return false;
  return true;
}

/** `request(file, opts)` as createThumbnailBackfill returns, loading its code on the first call. */
export function lazyThumbnailBackfill(onReady) {
  let request = null;
  let loading = null;
  const waiting = [];
  return (file, opts) => {
    if (request) { request(file, opts); return; }
    waiting.push([file, opts]);
    loading ||= import('./thumbnail-client').then(({ createThumbnailBackfill }) => {
      request = createThumbnailBackfill(onReady);
      for (const [f, o] of waiting.splice(0)) request(f, o);
    }, () => { loading = null; });
  };
}

/**
 * A backfilled row, folded into the one on screen: the new previews and
 * facts, keeping everything the listing already holds (its signed original
 * URL, tags, review state).
 */
export function mergeBackfilled(row, f) {
  if (!row || !f || row.id !== f.id) return row;
  const next = { ...row };
  for (const k of ['thumbnailUrl', 'thumbnailKey', 'smUrl', 'xsUrl', 'thumbSizes', 'posterUrl', 'posterKey', 'metadata', 'seq']) {
    if (f[k] !== undefined) next[k] = f[k];
  }
  return next;
}

