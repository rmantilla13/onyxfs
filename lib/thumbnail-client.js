// lib/thumbnail-client.js — thumbnails, made in the browser.
//
// The browser already has the file in hand at upload time and decodes JPEG,
// PNG, WebP, H.264 and VP9 natively, so it draws a WebP there and puts it in
// the bucket beside the original. No ffmpeg or sharp in a serverless
// function, and nothing that has to download a multi-gigabyte master.
//
// Two sizes, both from lib/poster.js: the grid poster, which covers the
// largest card on a 2x screen, and — for a video — the player's poster, which
// fills the detail page's stage. They are the same frame.
//
// Files uploaded before this existed get the same treatment lazily: when a
// tile without a thumbnail scrolls into view for someone who can edit it, the
// original is decoded from its presigned URL and the thumbnail recorded. So
// does a tile whose thumbnail is one of the old 480px ones (FileCard notices
// when it loads), after the missing ones. Anything the browser cannot decode
// (HEIC, TIFF, ProRes, RAW) is skipped and keeps its typed placeholder.

import { putToBucket } from './multipart-client';
import { drawableKind, THUMB_SOURCE_MAX_BYTES } from './media';
import {
  gridPosterSize, playerPosterFor, downscalePlan, posterTimes, frameStats, chooseFrame,
  isBlankFrame, WEBP_QUALITY, JPEG_QUALITY,
} from './poster';

const TIMEOUT_MS = 20000;
// How long to wait for requestVideoFrameCallback after a seek before drawing
// anyway. It never fires in a hidden tab, or for a video in no document in
// some browsers — and by `seeked` Chrome has the frame regardless.
const FRAME_WAIT_MS = 250;
// A file that could not be thumbnailed is not retried from this browser for a
// week, so a library of TIFFs does not re-download every original per visit.
const SKIP_PREFIX = 'onyx:thumb-skip:';
const SKIP_MS = 7 * 24 * 3600 * 1000;

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
    const v = document.createElement('video');
    cleanup.push(() => { v.removeAttribute('src'); v.load(); });
    v.muted = true;
    v.playsInline = true;
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
 * The poster frame of a video: the first of posterTimes that is not black or
 * flat, or the least blank of them. Each try is one seek; for a backfill that
 * is a few range requests, and the first try is almost always kept.
 */
async function loadVideoFrame(src, remote, cleanup) {
  const v = await openVideo(src, remote, cleanup);
  const d = Number.isFinite(v.duration) ? v.duration : 0;
  const times = posterTimes(d);
  const stats = [];
  for (const t of times) {
    await seekFrame(v, t);
    const s = sampleFrame(v);
    stats.push(s || { mean: 128, spread: 128 });
    if (!s || !isBlankFrame(s)) break;
  }
  const pick = chooseFrame(stats);
  if (pick !== stats.length - 1) await seekFrame(v, times[pick]);
  return { el: v, width: v.videoWidth, height: v.videoHeight, duration: d };
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(
    (b) => (b ? resolve(b) : reject(new Error('Could not encode the thumbnail.'))), type, quality
  ));
}

async function encode(canvas) {
  // A browser that cannot encode WebP (Safari) hands back a PNG instead; JPEG
  // is the smaller fallback for a photo.
  const webp = await toBlob(canvas, 'image/webp', WEBP_QUALITY);
  return webp.type === 'image/webp' ? webp : toBlob(canvas, 'image/jpeg', JPEG_QUALITY);
}

/**
 * Draw `el` (an image, a video on its frame, or a canvas) of `from` size down
 * to `to`, halving at most per step (downscalePlan). Returns the last canvas.
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
 * Encode the grid poster, and for a video the player poster, from one frame.
 * The grid poster is drawn from the player's canvas — it is already a clean
 * downscale of the frame, and far fewer pixels to read. A video whose player
 * poster would be barely bigger than the grid one gets none (playerPosterFor).
 */
async function draw(frame, kind) {
  const source = { width: frame.width, height: frame.height };
  const grid = gridPosterSize(source);
  if (!grid) throw new Error('The file has no dimensions.');
  const player = kind === 'video' ? playerPosterFor(source) : null;
  if (!player) return { blob: await encode(drawDown(frame.el, source, grid)) };

  const big = drawDown(frame.el, source, player);
  const small = drawDown(big, player, grid);
  const [blob, poster] = await Promise.all([encode(small), encode(big)]);
  return { blob, poster };
}

/**
 * Draw a thumbnail of `file` ({ name, mime, size }) from `source`: a File or
 * Blob at upload time, or the original's presigned URL for a backfill.
 * Resolves { blob, poster?, media: { width, height, duration? } } — `poster`
 * for a video only — or null when the format is not one a browser draws.
 */
export async function makeThumbnail(source, file) {
  const kind = drawableKind(file);
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
      const remote = typeof src === 'string';
      if (!remote) {
        const url = URL.createObjectURL(src);
        cleanup.push(() => URL.revokeObjectURL(url));
        src = url;
      }
      const frame = kind === 'image' ? await loadImage(src) : await loadVideoFrame(src, remote, cleanup);
      const media = { width: frame.width, height: frame.height };
      if (frame.duration) media.duration = frame.duration;
      return { ...(await draw(frame, kind)), media };
    })();
    work.catch(() => {}); // lost the race; its failure is not news
    return await Promise.race([work, timeout(TIMEOUT_MS)]);
  } finally {
    for (const fn of cleanup) fn();
  }
}

/**
 * Put a preview in the bucket under a key the server names. Resolves the key.
 * `poster` asks for a player-poster key (`<uuid>.poster.webp`), which only
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

/** Upload a makeThumbnail result. Resolves { key, posterKey }; a poster that fails to upload is left out, not fatal. */
async function uploadPreviews(thumb) {
  const [key, posterKey] = await Promise.all([
    uploadThumbnail(thumb.blob),
    thumb.poster ? uploadThumbnail(thumb.poster, { poster: true }).catch(() => null) : null,
  ]);
  return { key, posterKey: posterKey || null };
}

/**
 * The thumbnail for a file being uploaded: { key, posterKey, media }, or
 * null. Never rejects — a file without a preview is still a file, and must
 * still upload.
 */
export async function thumbnailForUpload(file) {
  try {
    const thumb = await makeThumbnail(file, { name: file.name, mime: file.type, size: file.size });
    if (!thumb) return null;
    return { ...(await uploadPreviews(thumb)), media: thumb.media };
  } catch {
    return null;
  }
}

function skippedRecently(id) {
  try { return Date.now() - Number(localStorage.getItem(SKIP_PREFIX + id) || 0) < SKIP_MS; } catch { return false; }
}

function rememberSkip(id) {
  try { localStorage.setItem(SKIP_PREFIX + id, String(Date.now())); } catch {}
}

// Remaking a thumbnail that is merely small re-reads the original, so it is
// not done on a connection that has asked to save data.
function saveData() {
  try { return !!navigator.connection?.saveData; } catch { return false; }
}

/**
 * A queue that makes thumbnails one at a time, in the order tiles came into
 * view. Returns `request(file, { upgrade })`; `onReady(file)` receives the
 * row, presigned, once its thumbnail is recorded.
 *
 * `upgrade` is a tile whose thumbnail works but is one of the old small ones.
 * Those wait behind every missing thumbnail — a tile with no picture at all
 * matters more than a soft one.
 */
export function createThumbnailBackfill(onReady) {
  const seen = new Set();
  const missing = [];
  const upgrades = [];
  let running = false;

  async function run() {
    running = true;
    while (missing.length || upgrades.length) {
      const file = missing.length ? missing.shift() : upgrades.shift();
      try {
        // Ask first whether this person may record a thumbnail for the file.
        // Library-wide write access is not per-file access: a member may see
        // plenty of files that others added. Without asking, each of those
        // cost a download of the original and two orphaned uploads before
        // the PUT was refused — and with old thumbnails being remade, that
        // was most of a shared library.
        const may = await fetch(`/api/files/${file.id}/thumbnail`, { cache: 'no-store' });
        if (!may.ok) { rememberSkip(file.id); continue; }
        const thumb = await makeThumbnail(file.url, file);
        if (!thumb) { rememberSkip(file.id); continue; }
        const { key: thumbnailKey, posterKey } = await uploadPreviews(thumb);
        const r = await fetch(`/api/files/${file.id}/thumbnail`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ thumbnailKey, posterKey, media: thumb.media }),
        });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
        onReady(out.file);
      } catch {
        rememberSkip(file.id);
      }
    }
    running = false;
  }

  return (file, { upgrade = false } = {}) => {
    if (!file?.id || !file.url || file.storage !== 's3' || seen.has(file.id)) return;
    if (!drawableKind(file) || skippedRecently(file.id)) return;
    if (upgrade && saveData()) return;
    seen.add(file.id);
    (upgrade ? upgrades : missing).push(file);
    if (!running) run();
  };
}
