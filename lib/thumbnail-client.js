// lib/thumbnail-client.js — thumbnails, made in the browser.
//
// The browser already has the file in hand at upload time and decodes JPEG,
// PNG, WebP, H.264 and VP9 natively, so it draws a WebP there and puts it in
// the bucket beside the original. No ffmpeg or sharp in a serverless
// function, and nothing that has to download a multi-gigabyte master.
//
// Every size comes from lib/poster.js and is drawn from the one before it,
// halving at most per step:
//
//   source → large (a video's player poster, or an image's ≤2400px preview)
//          → grid poster (covers the widest card at 2x)
//          → sm (covers a card) → xs (covers a list row)
//
// The large picture and the grid poster are the same frame. The grid, sm and
// xs steps read small canvases, so they add a few milliseconds.
//
// Files uploaded before this existed catch up lazily, in the background, for
// someone who may edit them (createThumbnailBackfill):
//   missing  a tile with no thumbnail: the original is decoded, everything made
//   upgrade  a tile whose thumbnail is one of the old 480px ones: likewise
//   sizes    a thumbnail without sm/xs: drawn from the grid poster (~70 KB),
//            never from the original
//   preview  an image opened in Quick Look or on its page with no preview:
//            the original that was fetched to show it is handed over, so the
//            preview costs no second download. Only the preview is recorded
//            — the thumbnail, its siblings and the row's seq stay as they
//            are — and only when one would be made (lib/poster.js
//            imagePreviewFor); a file that gets none is remembered, so it is
//            not decoded again on every view (lib/preview-wanted.js).
//            A file with no thumbnail of ours gets its whole set from it.
// Anything the browser cannot decode (RAW, and HEIC or TIFF outside Safari —
// lib/decode-probe.js) keeps its typed placeholder.

import { putToBucket } from './multipart-client';
import { drawableKind, isThumbKey, THUMB_SOURCE_MAX_BYTES } from './media';
import { skippedRecently, rememberSkip, previewWanted, imageMime } from './preview-wanted.js';
import { saveData, watchActivity, whenQuiet } from './backfill-quiet.js';
import {
  gridPosterSize, playerPosterFor, imagePreviewFor, thumbSiblingSizes, downscalePlan, posterTimes, laterPosterTimes,
  coverTime, frameStats, isBlankFrame, WEBP_QUALITY, JPEG_QUALITY, PREVIEW_WEBP_QUALITY, PREVIEW_JPEG_QUALITY,
} from './poster';
import { decodeProbe, probedNow } from './decode-probe';
import { frameVideo } from './frame-video';
import { placeholderSize, placeholderFacts, compactPlaceholder, PLACEHOLDER_QUALITY } from './placeholder.js';
import { drawImageOffThread } from './thumbnail-offthread.js';

const TIMEOUT_MS = 20000;
// How long to wait for requestVideoFrameCallback after a seek before drawing
// anyway. It never fires in a hidden tab, or for a video in no document in
// some browsers — and by `seeked` Chrome has the frame regardless.
const FRAME_WAIT_MS = 250;

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out decoding the file.')), ms));
}

async function loadImage(src) {
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  await img.decode();
  return { el: img, width: img.naturalWidth, height: img.naturalHeight };
}

function openVideo(src, remote, cleanup) {
  return new Promise((resolve, reject) => {
    const v = frameVideo(cleanup);
    v.preload = 'metadata';
    // Drawing a cross-origin frame into a canvas needs a CORS response, or
    // the canvas is tainted and cannot be exported.
    if (remote) v.crossOrigin = 'anonymous';
    v.onerror = () => reject(new Error('This browser cannot decode the video.'));
    v.onloadedmetadata = () => {
      if (!v.videoWidth) reject(new Error('No video track this browser can decode.'));
      else resolve(v);
    };
    v.src = src;
  });
}

/**
 * Seek, and wait until the frame there can be drawn. `seeked` means the seek
 * finished, not necessarily that its frame is decoded — drawing then can
 * paint the previous one — so where requestVideoFrameCallback exists it gets
 * a moment to say a new frame is ready.
 */
function seekFrame(v, time) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    v.onerror = () => reject(new Error('The video errored while seeking.'));
    v.onseeked = () => {
      if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(() => done());
      setTimeout(done, FRAME_WAIT_MS);
    };
    try { v.currentTime = time; } catch (e) { reject(e); }
  });
}

/** Luma statistics of the frame on screen, from a copy a few dozen pixels wide. */
function sampleFrame(v) {
  const canvas = document.createElement('canvas');
  canvas.width = 48;
  canvas.height = Math.max(1, Math.round(48 * v.videoHeight / v.videoWidth));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
  try { return frameStats(ctx.getImageData(0, 0, canvas.width, canvas.height).data); }
  // A tainted canvas cannot be read — nor, later, exported, which fails there.
  catch { return null; }
}

/**
 * The poster frame of a video: the first of posterTimes, then of
 * laterPosterTimes, that is not black or flat. Each try is one seek; for a
 * backfill that is a few range requests, and the first try is almost always
 * kept. When every one is blank there is no poster — a black tile would be
 * kept for good, where no thumbnail keeps the placeholder. With `at` (a cover
 * someone chose, in seconds) it is the frame there, as it is.
 */
async function loadVideoFrame(src, remote, cleanup, at = null) {
  const v = await openVideo(src, remote, cleanup);
  const d = Number.isFinite(v.duration) ? v.duration : 0;
  if (at != null) {
    await seekFrame(v, coverTime(at, d));
    return { el: v, width: v.videoWidth, height: v.videoHeight, duration: d };
  }
  for (const t of [...posterTimes(d), ...laterPosterTimes(d)]) {
    await seekFrame(v, t);
    const s = sampleFrame(v);
    if (!s || !isBlankFrame(s)) return { el: v, width: v.videoWidth, height: v.videoHeight, duration: d };
  }
  throw new Error('Every frame tried was blank.');
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(
    (b) => (b ? resolve(b) : reject(new Error('Could not encode the thumbnail.'))), type, quality
  ));
}

async function encode(canvas, { webp = WEBP_QUALITY, jpeg = JPEG_QUALITY } = {}) {
  // A browser that cannot encode WebP (Safari) hands back a PNG instead; JPEG
  // is the smaller fallback for a photo.
  const blob = await toBlob(canvas, 'image/webp', webp);
  return blob.type === 'image/webp' ? blob : toBlob(canvas, 'image/jpeg', jpeg);
}

/** Encode as exactly `type`, or null when this browser cannot. Siblings share their thumbnail's format (and key extension). */
async function encodeAs(canvas, type) {
  const blob = await toBlob(canvas, type, type === 'image/webp' ? WEBP_QUALITY : JPEG_QUALITY).catch(() => null);
  return blob && blob.type === type ? blob : null;
}

/**
 * Draw `el` (an image, a video on its frame, or a canvas) of `from` size down
 * to `to`, halving at most per step (downscalePlan). Returns the last canvas.
 * `el` itself is left alone, so a canvas can be drawn down twice.
 */
function drawDown(el, from, to) {
  let src = el;
  let canvas = null;
  for (const step of downscalePlan(from, to)) {
    canvas = document.createElement('canvas');
    canvas.width = step.width;
    canvas.height = step.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, step.width, step.height);
    // An intermediate is dropped as soon as the next step has read it.
    if (src !== el && src instanceof HTMLCanvasElement) { src.width = 0; src.height = 0; }
    src = canvas;
  }
  return canvas;
}

/**
 * The placeholder of a picture (lib/placeholder.js) — `canvas`, of `from`
 * size, drawn down to a couple of dozen pixels — as a data URL: WebP, or
 * JPEG from a browser that cannot encode WebP. Null when it would not be one.
 */
function placeholderOf(canvas, from) {
  const to = placeholderSize(from);
  if (!canvas || !to) return null;
  const tiny = to.width < from.width || to.height < from.height ? drawDown(canvas, from, to) : canvas;
  try {
    let url = tiny.toDataURL('image/webp', PLACEHOLDER_QUALITY);
    if (!url.startsWith('data:image/webp')) url = tiny.toDataURL('image/jpeg', PLACEHOLDER_QUALITY);
    // Less the colour profile the canvas wrapped it in: most of its bytes.
    return placeholderFacts(compactPlaceholder(url));
  } catch {
    return null;
  } finally {
    if (tiny !== canvas) { tiny.width = 0; tiny.height = 0; }
  }
}

const ALPHA_TYPES = /image\/(png|webp|gif|avif)/i;

/**
 * Every rendition of one frame, each drawn from the one before it:
 *   large    a video's player poster (playerPosterFor), or an image's preview
 *            (imagePreviewFor) — none when the original serves
 *   grid     the thumbnail
 *   sm, xs   the thumbnail's siblings (thumbSiblingSizes), in its format
 *   tiny     its placeholder (lib/placeholder.js), a data URL
 * Resolves { blob, poster?, siblings: { sm?, xs? }, placeholder? }.
 */
async function draw(frame, kind, file = {}) {
  const source = { width: frame.width, height: frame.height };
  const grid = gridPosterSize(source);
  if (!grid) throw new Error('The file has no dimensions.');
  const large = kind === 'video'
    ? playerPosterFor(source)
    : imagePreviewFor(source, { bytes: file.size, mime: imageMime(file) });

  let bigCanvas = null;
  let gridCanvas;
  if (large) {
    bigCanvas = drawDown(frame.el, source, large);
    gridCanvas = drawDown(bigCanvas, large, grid);
  } else {
    gridCanvas = drawDown(frame.el, source, grid);
  }

  // The siblings are drawn from the grid canvas before it is encoded and
  // released: a few hundred pixels a side, so a few milliseconds each.
  const sizes = thumbSiblingSizes(source);
  const smCanvas = sizes.sm ? drawDown(gridCanvas, grid, sizes.sm) : null;
  const xsCanvas = sizes.xs ? (smCanvas ? drawDown(smCanvas, sizes.sm, sizes.xs) : drawDown(gridCanvas, grid, sizes.xs)) : null;
  // And the tile's stand-in while any of them loads (lib/placeholder.js),
  // from the smallest: a few hundred bytes that ride in the row.
  const placeholder = xsCanvas ? placeholderOf(xsCanvas, sizes.xs)
    : smCanvas ? placeholderOf(smCanvas, sizes.sm) : placeholderOf(gridCanvas, grid);

  const blob = await encode(gridCanvas);
  const siblings = {};
  if (smCanvas) { const b = await encodeAs(smCanvas, blob.type); if (b) siblings.sm = b; }
  if (xsCanvas) { const b = await encodeAs(xsCanvas, blob.type); if (b) siblings.xs = b; }

  let poster = null;
  if (bigCanvas) {
    const quality = kind === 'image' ? { webp: PREVIEW_WEBP_QUALITY, jpeg: PREVIEW_JPEG_QUALITY } : undefined;
    poster = await encode(bigCanvas, quality);
    // A JPEG preview of a picture that may have transparency would put it on
    // black: the original serves instead. (The thumbnail's own JPEG fallback
    // has the same problem, from before this.)
    if (kind === 'image' && poster.type === 'image/jpeg' && ALPHA_TYPES.test(String(file.mime || file.type || ''))) poster = null;
    bigCanvas.width = 0;
    bigCanvas.height = 0;
  }
  return { blob, ...(poster ? { poster } : {}), siblings, ...(placeholder ? { placeholder } : {}) };
}

/**
 * Draw a thumbnail of `file` ({ name, mime, size }) from `source`: a File or
 * Blob at upload time (or the original a viewer already fetched), or the
 * original's presigned URL for a backfill. Resolves
 * { blob, poster?, siblings, media: { width, height, duration? } } — `poster`
 * the large picture (draw) — or null when the format is not one this browser
 * draws. `at` picks a video's frame instead of posterTimes (setVideoCover).
 */
export async function makeThumbnail(source, file, { at = null } = {}) {
  const kind = drawableKind(file, { probe: probedNow() || (await decodeProbe().catch(() => null)) });
  if (!kind) return null;
  if (kind === 'image' && Number(file.size) > THUMB_SOURCE_MAX_BYTES) return null;
  const cleanup = [];
  try {
    const work = (async () => {
      let src = source;
      if (typeof source === 'string' && kind === 'image') {
        // Fetched rather than set on an <img>, so the canvas is never tainted,
        // and with no-store so a cached non-CORS copy from the grid is not
        // reused for a CORS request.
        const r = await fetch(source, { mode: 'cors', cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        src = await r.blob();
      }
      if (kind === 'image') {
        // In a worker where this browser can, decoded straight to the largest
        // size needed (lib/thumbnail-offthread.js). Null: drawn here, as ever.
        const off = new AbortController();
        cleanup.push(() => off.abort());
        const made = await drawImageOffThread(src, {
          bytes: file.size, mime: imageMime(file), transparent: ALPHA_TYPES.test(String(file.mime || file.type || '')),
        }, off.signal);
        if (made) return made;
      }
      const remote = typeof src === 'string';
      if (!remote) {
        const url = URL.createObjectURL(src);
        cleanup.push(() => URL.revokeObjectURL(url));
        src = url;
      }
      const frame = kind === 'image' ? await loadImage(src) : await loadVideoFrame(src, remote, cleanup, at);
      const media = { width: frame.width, height: frame.height };
      if (frame.duration) media.duration = frame.duration;
      return { ...(await draw(frame, kind, file)), media };
    })();
    work.catch(() => {}); // lost the race; its failure is not news
    return await Promise.race([work, timeout(TIMEOUT_MS)]);
  } finally {
    for (const fn of cleanup) fn();
  }
}

/**
 * Put a preview in the bucket under a key the server names. Resolves the key.
 * `poster` asks for a large-picture key (`<uuid>.poster.webp`), which only
 * the poster column accepts.
 */
export async function uploadThumbnail(blob, { poster = false } = {}) {
  const res = await fetch('/api/files/presign', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [poster ? 'poster' : 'thumb']: true, contentType: blob.type }),
  });
  const pre = await res.json().catch(() => ({}));
  if (!res.ok || pre.error) throw new Error(pre.error || `Could not start the thumbnail upload (HTTP ${res.status}).`);
  await putToBucket(pre.putUrl, blob, {
    contentType: blob.type,
    headers: pre.cacheControl ? { 'cache-control': pre.cacheControl } : undefined,
  });
  return pre.key;
}

/** PUT each sibling blob to its presigned URL; resolves the sizes that landed. */
async function putSiblings(siblings = {}, targets = {}, { contentType, cacheControl } = {}) {
  const sizes = Object.keys(siblings).filter((size) => targets[size]?.putUrl);
  const landed = await Promise.all(sizes.map((size) => putToBucket(targets[size].putUrl, siblings[size], {
    contentType: contentType || siblings[size].type,
    headers: cacheControl ? { 'cache-control': cacheControl } : undefined,
  }).then(() => size, () => null)));
  return landed.filter(Boolean);
}

/**
 * Upload a makeThumbnail result: the grid thumbnail with its siblings under
 * one uuid, and the large picture beside them. Resolves
 * { key, posterKey, thumbSizes }; a poster or a sibling that fails to upload
 * is left out, not fatal — only the sizes that landed are reported.
 */
async function uploadPreviews(thumb) {
  const sizes = Object.keys(thumb.siblings || {});
  const gridUpload = (async () => {
    const res = await fetch('/api/files/presign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thumb: true, sizes, contentType: thumb.blob.type }),
    });
    const pre = await res.json().catch(() => ({}));
    if (!res.ok || pre.error) throw new Error(pre.error || `Could not start the thumbnail upload (HTTP ${res.status}).`);
    const [, thumbSizes] = await Promise.all([
      putToBucket(pre.putUrl, thumb.blob, {
        contentType: thumb.blob.type,
        headers: pre.cacheControl ? { 'cache-control': pre.cacheControl } : undefined,
      }),
      putSiblings(thumb.siblings, pre.siblings, { contentType: thumb.blob.type, cacheControl: pre.cacheControl }),
    ]);
    return { key: pre.key, thumbSizes };
  })();
  const [grid, posterKey] = await Promise.all([
    gridUpload,
    thumb.poster ? uploadThumbnail(thumb.poster, { poster: true }).catch(() => null) : null,
  ]);
  return { key: grid.key, posterKey: posterKey || null, thumbSizes: grid.thumbSizes };
}

/**
 * Record previews already in the bucket — uploadPreviews' { key, posterKey,
 * thumbSizes }, and the `media` read while drawing them — on an existing
 * file, over any thumbnail it had (the PUT deletes the replaced previews and
 * bumps seq). Resolves the row, signed.
 */
export async function attachThumbnail(file, { key: thumbnailKey, posterKey, thumbSizes, media, placeholder }) {
  const r = await fetch(`/api/files/${file.id}/thumbnail`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ thumbnailKey, posterKey, thumbSizes, media, placeholder }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
  return out.file;
}

/** Upload a makeThumbnail result and record it on an existing file (attachThumbnail). */
export async function recordThumbnail(file, thumb) {
  return attachThumbnail(file, { ...(await uploadPreviews(thumb)), media: thumb.media, placeholder: thumb.placeholder });
}

// Rows an upload in this page is still attaching a thumbnail to, by id: a
// promise of the row once it has it, or of null. An upload is recorded
// without waiting long for its thumbnail (lib/upload-client.js), so the grid
// can show the file first — and its tile, with no picture, asks the backfill
// for one (again at every refresh), which would download the original to
// draw a second. The backfill waits for the upload's instead, and draws only
// if that one does not land. Good for a minute after it lands, for a listing
// fetched meanwhile that does not have the thumbnail yet; the latest
// FROM_UPLOAD_MAX.
const fromUpload = new Map(); // id → { done: Promise<row | null>, until, waiting }
const FROM_UPLOAD_KEEP_MS = 60_000;
const FROM_UPLOAD_MAX = 500;

/** The upload that made row `id` is attaching its thumbnail: `work` resolves the row, or null. */
export function thumbnailFromUpload(id, work) {
  const entry = { until: Infinity };
  entry.done = Promise.resolve(work).catch(() => null);
  entry.done.then(() => { entry.until = Date.now() + FROM_UPLOAD_KEEP_MS; });
  fromUpload.delete(id);
  fromUpload.set(id, entry);
  if (fromUpload.size > FROM_UPLOAD_MAX) fromUpload.delete(fromUpload.keys().next().value);
  return entry.done;
}

/**
 * A video's cover, chosen by someone who may edit it: the frame at `time`
 * seconds, drawn, uploaded and recorded exactly as a backfilled thumbnail is,
 * replacing the one it had. New keys, so every URL of the old picture goes
 * with it. Resolves the row, signed; rejects with a message to show.
 */
export async function setVideoCover(file, time) {
  const may = await fetch(`/api/files/${file.id}/thumbnail`, { cache: 'no-store' });
  if (!may.ok) throw new Error(may.status === 403 ? 'You can view this video but not change its cover.' : `Could not change the cover (HTTP ${may.status}).`);
  const thumb = await makeThumbnail(file.url, file, { at: time });
  if (!thumb) throw new Error('This browser cannot draw a frame of this video.');
  return recordThumbnail(file, thumb);
}

/**
 * The thumbnail for a file being uploaded: { key, posterKey, thumbSizes,
 * media, placeholder }, or null. Never rejects — a file without a preview is
 * still a file, and must still upload.
 */
export async function thumbnailForUpload(file) {
  try {
    const thumb = await makeThumbnail(file, { name: file.name, mime: file.type, size: file.size });
    if (!thumb) return null;
    return { ...(await uploadPreviews(thumb)), media: thumb.media, placeholder: thumb.placeholder };
  } catch {
    return null;
  }
}

export { mergeBackfilled } from './backfill.js';

/** Decode a small image blob (the grid poster) to something drawImage takes, with its size. */
async function decodeSmall(blob) {
  if (typeof createImageBitmap === 'function') {
    const bmp = await createImageBitmap(blob);
    return { el: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close?.() };
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    return { ...img, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The sizes job: sm and xs drawn from the grid poster the tile shows, for a
 * thumbnail that has none. The route hands out PUT URLs for the row's own
 * thumbnail (and refuses anyone who may not write it) and records the sizes
 * against that thumbnail. Resolves the row, signed, or null.
 */
export async function makeSizes(file) {
  const pre = await fetch(`/api/files/${file.id}/thumbnail/sizes`, { method: 'POST', cache: 'no-store' });
  if (!pre.ok) return { skip: true };
  const plan = await pre.json();
  // The siblings are drawn from the thumbnail this row shows and recorded
  // against the one the server has: when those differ (replaced since the
  // listing was read), they would be another picture's. Not a skip — the
  // next listing has the new thumbnail.
  if (!plan.thumbnailKey || plan.thumbnailKey !== file.thumbnailKey) return { stale: true };
  // Fetched with CORS so the canvas can be exported; no-store, so a cached
  // non-CORS copy from the tile's <img> is not reused for it.
  const r = await fetch(file.thumbnailUrl, { mode: 'cors', cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const grid = await decodeSmall(await r.blob());
  try {
    const md = file.metadata || {};
    const source = Number(md.width) > 0 && Number(md.height) > 0 ? { width: Number(md.width), height: Number(md.height) } : grid;
    const sizes = thumbSiblingSizes(source);
    const gridSize = { width: grid.width, height: grid.height };
    const siblings = {};
    const fit = (want) => (want.width < gridSize.width ? want : null);
    const sm = sizes.sm && fit(sizes.sm) ? drawDown(grid.el, gridSize, sizes.sm) : null;
    const xs = sizes.xs && fit(sizes.xs) ? (sm ? drawDown(sm, sizes.sm, sizes.xs) : drawDown(grid.el, gridSize, sizes.xs)) : null;
    if (sm) { const b = await encodeAs(sm, plan.contentType); if (b) siblings.sm = b; }
    if (xs) { const b = await encodeAs(xs, plan.contentType); if (b) siblings.xs = b; }
    if (!Object.keys(siblings).length) return { skip: true };
    // Its placeholder too, while the pictures are in hand: the same download.
    const placeholder = file.metadata?.placeholder ? null
      : placeholderOf(xs || sm || grid.el, xs ? sizes.xs : sm ? sizes.sm : gridSize);
    const landed = await putSiblings(siblings, plan.siblings, { contentType: plan.contentType, cacheControl: plan.cacheControl });
    if (!landed.length) throw new Error('No sibling uploaded.');
    const rec = await fetch(`/api/files/${file.id}/thumbnail/sizes`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thumbnailKey: plan.thumbnailKey, sizes: landed }),
    });
    const out = await rec.json().catch(() => ({}));
    if (!rec.ok) throw new Error(out.error || `HTTP ${rec.status}`);
    if (placeholder) {
      const withIt = await putPlaceholder(file, placeholder, plan.thumbnailKey).catch(() => null);
      if (withIt) return { file: withIt };
    }
    return { file: out.file };
  } finally {
    grid.close();
  }
}

/**
 * Record `placeholder` on `file`, as the tiny copy of the thumbnail it was
 * drawn from (`thumbnailKey`). Resolves the row, signed — or null when the
 * row's thumbnail is another one now, which the next listing shows.
 */
async function putPlaceholder(file, placeholder, thumbnailKey = file.thumbnailKey) {
  const r = await fetch(`/api/files/${file.id}/placeholder`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ placeholder, thumbnailKey }),
  });
  if (r.status === 409) return null;
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
  return out.file;
}

/**
 * The placeholder job: a thumbnail from before placeholders, with its
 * siblings (the sizes job draws the placeholder of one without), gets its
 * tiny copy (lib/placeholder.js) — drawn from the smallest picture the row
 * has, a few kilobytes. Resolves { file } or { skip }.
 */
export async function makePlaceholder(file) {
  const from = file.xsUrl || file.smUrl || file.thumbnailUrl;
  if (!from || !isThumbKey(file.thumbnailKey)) return { skip: true };
  // CORS, so the canvas can be exported; no-store, so the tile's own
  // non-CORS copy is not reused for it.
  const r = await fetch(from, { mode: 'cors', cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const pic = await decodeSmall(await r.blob());
  try {
    const placeholder = placeholderOf(pic.el, { width: pic.width, height: pic.height });
    if (!placeholder) return { skip: true };
    const row = await putPlaceholder(file, placeholder);
    return row ? { file: row } : {};
  } finally {
    pic.close();
  }
}

/**
 * The preview job: an image that has its thumbnail, and whose original a
 * viewer fetched to show it (`blob`). Decoded once more here, the large
 * preview is drawn and uploaded, and recorded ALONE (the thumbnail PUT's
 * preview-only form): the thumbnail and its siblings are kept, seq does not
 * move, nothing is deleted. When no preview would be made — a GIF, a small
 * or barely-larger picture, a transparent one this browser can only encode
 * as JPEG — nothing is uploaded, and { skip } says so, to be remembered.
 */
async function makePreview(file, blob) {
  const may = await fetch(`/api/files/${file.id}/thumbnail`, { cache: 'no-store' });
  if (!may.ok) return { skip: true };
  const url = URL.createObjectURL(blob);
  let big = null;
  try {
    const work = (async () => {
      const frame = await loadImage(url);
      const source = { width: frame.width, height: frame.height };
      const mime = imageMime(file) || blob.type;
      const large = imagePreviewFor(source, { bytes: file.size, mime });
      if (!large) return { skip: true };
      big = drawDown(frame.el, source, large);
      const poster = await encode(big, { webp: PREVIEW_WEBP_QUALITY, jpeg: PREVIEW_JPEG_QUALITY });
      if (poster.type === 'image/jpeg' && ALPHA_TYPES.test(mime)) return { skip: true };
      return { poster, media: source };
    })();
    work.catch(() => {});
    const made = await Promise.race([work, timeout(TIMEOUT_MS)]);
    if (made.skip) return made;
    const posterKey = await uploadThumbnail(made.poster, { poster: true });
    const r = await fetch(`/api/files/${file.id}/thumbnail`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ posterKey, media: made.media }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
    return { file: out.file };
  } finally {
    if (big) { big.width = 0; big.height = 0; }
    URL.revokeObjectURL(url);
  }
}

// Files whose handed-over original has been dealt with in this document —
// by any queue: the files view and the file page each have one, and a file
// looked at in both is still one preview.
const previewDone = new Set();

/**
 * A queue that makes previews one at a time, in the background. Returns
 * `request(file, opts)`; `onReady(file)` receives the row, presigned, once
 * something new is recorded for it (fold it in with mergeBackfilled).
 *
 *   request(file)                        missing thumbnail
 *   request(file, { placeholder: true }) a thumbnail without its placeholder
 *   request(file, { upgrade: true })     an old small thumbnail
 *   request(file, { sizes: true })       a thumbnail without siblings
 *   request(file, { blob })              the original, already fetched to show it
 *
 * They run in that order of priority — a tile with no picture at all matters
 * more than one that shows nothing until it loads, that more than a soft one,
 * and all of them more than bytes saved later.
 */
export function createThumbnailBackfill(onReady) {
  const seen = new Set();
  const queues = { missing: [], placeholder: [], upgrade: [], sizes: [], blob: [], preview: [] };
  const ORDER = ['missing', 'placeholder', 'upgrade', 'sizes', 'blob', 'preview'];
  const OWN_SKIP = new Set(['sizes', 'preview', 'placeholder']);
  let running = false;
  watchActivity();
  decodeProbe().catch(() => {});

  const next = () => {
    for (const mode of ORDER) if (queues[mode].length) return { mode, ...queues[mode].shift() };
    return null;
  };

  async function run() {
    running = true;
    for (let job = next(); job; job = next()) {
      const { mode, file, blob } = job;
      await whenQuiet();
      try {
        if (mode === 'sizes' || mode === 'placeholder') {
          const out = await (mode === 'sizes' ? makeSizes(file) : makePlaceholder(file));
          if (out.file) onReady(out.file);
          else if (out.skip) rememberSkip(file.id, mode);
          continue;
        }
        if (mode === 'preview') {
          previewDone.add(file.id);
          const out = await makePreview(file, blob);
          if (out.file) onReady(out.file);
          else if (out.skip) rememberSkip(file.id, 'preview');
          continue;
        }
        // Ask first whether this person may record a thumbnail for the file.
        // Library-wide write access is not per-file access: a member may see
        // plenty of files that others added. Without asking, each of those
        // cost a download of the original and two orphaned uploads before
        // the PUT was refused — and with old thumbnails being remade, that
        // was most of a shared library.
        if (mode === 'blob') previewDone.add(file.id);
        const may = await fetch(`/api/files/${file.id}/thumbnail`, { cache: 'no-store' });
        if (!may.ok) { rememberSkip(file.id); continue; }
        const thumb = await makeThumbnail(blob || file.url, file);
        if (!thumb) { rememberSkip(file.id); continue; }
        onReady(await recordThumbnail(file, thumb));
      } catch {
        rememberSkip(file.id, OWN_SKIP.has(mode) ? mode : undefined);
      }
    }
    running = false;
  }

  const request = (file, { upgrade = false, sizes = false, placeholder = false, blob = null } = {}) => {
    if (!file?.id || file.storage !== 's3') return;
    // An original handed over: only the preview, for a file with a thumbnail
    // of ours; the whole set for one without.
    const mode = blob ? (isThumbKey(file.thumbnailKey) ? 'preview' : 'blob')
      : sizes ? 'sizes' : placeholder ? 'placeholder' : upgrade ? 'upgrade' : 'missing';
    const tag = `${OWN_SKIP.has(mode) ? mode : 'thumb'}:${file.id}`;
    if (seen.has(tag)) return;
    // Uploaded from this page, with its own thumbnail on the way or just
    // landed (fromUpload), and not on this tile yet. One wait at a time; a
    // row without a picture to show is no answer, and the backfill draws.
    // A tile that has the thumbnail and failed to show it is not asking
    // about this one.
    const coming = mode === 'missing' && !file.thumbnailUrl ? fromUpload.get(file.id) : null;
    if (coming && Date.now() >= coming.until) fromUpload.delete(file.id);
    else if (coming) {
      if (!coming.waiting) {
        coming.waiting = true;
        coming.done.then((row) => {
          coming.waiting = false;
          if (row?.thumbnailUrl) return onReady(row);
          if (fromUpload.get(file.id) === coming) fromUpload.delete(file.id);
          return request(file);
        });
      }
      return;
    }
    if (mode === 'sizes') {
      if (!file.thumbnailUrl || !isThumbKey(file.thumbnailKey) || file.thumbSizes?.length) return;
      if (saveData() || skippedRecently(file.id, 'sizes')) return;
    } else if (mode === 'placeholder') {
      if (!file.thumbnailUrl || !isThumbKey(file.thumbnailKey) || file.metadata?.placeholder) return;
      if (file.can?.edit === false || saveData() || skippedRecently(file.id, 'placeholder')) return;
    } else if (blob) {
      if (previewDone.has(file.id) || !previewWanted(file, { probe: probedNow() })) return;
    } else {
      if (!drawableKind(file, { probe: probedNow() }) || skippedRecently(file.id)) return;
      if (!file.url) return;
      if (upgrade && saveData()) return;
    }
    seen.add(tag);
    queues[mode].push({ file, blob });
    if (!running) run();
  };
  return request;
}
