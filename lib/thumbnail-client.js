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
//   fromBlob an image opened in Quick Look or on its page with no preview:
//            the original that was fetched to show it is handed over, so the
//            preview costs no second download
// Anything the browser cannot decode (RAW, and HEIC or TIFF outside Safari —
// lib/decode-probe.js) keeps its typed placeholder.

import { putToBucket } from './multipart-client';
import { drawableKind, isThumbKey, THUMB_SOURCE_MAX_BYTES } from './media';
import {
  gridPosterSize, playerPosterFor, imagePreviewFor, thumbSiblingSizes, downscalePlan, posterTimes,
  frameStats, chooseFrame, isBlankFrame, WEBP_QUALITY, JPEG_QUALITY, PREVIEW_WEBP_QUALITY, PREVIEW_JPEG_QUALITY,
} from './poster';
import { decodeProbe, probedNow } from './decode-probe';

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

const ALPHA_TYPES = /image\/(png|webp|gif|avif)/i;

/**
 * Every rendition of one frame, each drawn from the one before it:
 *   large    a video's player poster (playerPosterFor), or an image's preview
 *            (imagePreviewFor) — none when the original serves
 *   grid     the thumbnail
 *   sm, xs   the thumbnail's siblings (thumbSiblingSizes), in its format
 * Resolves { blob, poster?, siblings: { sm?, xs? } }.
 */
async function draw(frame, kind, file = {}) {
  const source = { width: frame.width, height: frame.height };
  const grid = gridPosterSize(source);
  if (!grid) throw new Error('The file has no dimensions.');
  const large = kind === 'video'
    ? playerPosterFor(source)
    : imagePreviewFor(source, { bytes: file.size, mime: file.mime || file.type || (/\.gif$/i.test(file.name || '') ? 'image/gif' : '') });

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
  return { blob, ...(poster ? { poster } : {}), siblings };
}

/**
 * Draw a thumbnail of `file` ({ name, mime, size }) from `source`: a File or
 * Blob at upload time (or the original a viewer already fetched), or the
 * original's presigned URL for a backfill. Resolves
 * { blob, poster?, siblings, media: { width, height, duration? } } — `poster`
 * the large picture (draw) — or null when the format is not one this browser
 * draws.
 */
export async function makeThumbnail(source, file) {
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
      const remote = typeof src === 'string';
      if (!remote) {
        const url = URL.createObjectURL(src);
        cleanup.push(() => URL.revokeObjectURL(url));
        src = url;
      }
      const frame = kind === 'image' ? await loadImage(src) : await loadVideoFrame(src, remote, cleanup);
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
 * The thumbnail for a file being uploaded: { key, posterKey, thumbSizes,
 * media }, or null. Never rejects — a file without a preview is still a
 * file, and must still upload.
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

function skippedRecently(id, what = '') {
  try { return Date.now() - Number(localStorage.getItem(SKIP_PREFIX + (what ? `${what}:` : '') + id) || 0) < SKIP_MS; } catch { return false; }
}

function rememberSkip(id, what = '') {
  try { localStorage.setItem(SKIP_PREFIX + (what ? `${what}:` : '') + id, String(Date.now())); } catch {}
}

// Remaking a thumbnail that is merely small re-reads the original, so it is
// not done on a connection that has asked to save data; nor are siblings,
// which only save bytes later.
function saveData() {
  try { return !!navigator.connection?.saveData; } catch { return false; }
}

// ── Staying out of the way ──────────────────────────────────────────────────
// A backfill job decodes and encodes on the main thread. It starts only when
// the page is idle, and waits while it is being scrolled (a scroll event in
// the last 150 ms) or pressed, so it never lands in the middle of a gesture.
const QUIET_MS = 150;
let lastScroll = 0;
let pointerDown = false;
let watching = false;
function watchActivity() {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  window.addEventListener('scroll', () => { lastScroll = performance.now(); }, { passive: true, capture: true });
  window.addEventListener('pointerdown', () => { pointerDown = true; }, { passive: true, capture: true });
  const up = () => { pointerDown = false; };
  window.addEventListener('pointerup', up, { passive: true, capture: true });
  window.addEventListener('pointercancel', up, { passive: true, capture: true });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function idle() {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 2000 });
    else setTimeout(resolve, 50);
  });
}
async function whenQuiet() {
  for (let i = 0; i < 400; i++) {
    await idle();
    if (!pointerDown && performance.now() - lastScroll > QUIET_MS) return;
    await sleep(QUIET_MS);
  }
}

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
async function makeSizes(file) {
  const pre = await fetch(`/api/files/${file.id}/thumbnail/sizes`, { method: 'POST', cache: 'no-store' });
  if (!pre.ok) return { skip: true };
  const plan = await pre.json();
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
    const landed = await putSiblings(siblings, plan.siblings, { contentType: plan.contentType, cacheControl: plan.cacheControl });
    if (!landed.length) throw new Error('No sibling uploaded.');
    const rec = await fetch(`/api/files/${file.id}/thumbnail/sizes`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thumbnailKey: plan.thumbnailKey, sizes: landed }),
    });
    const out = await rec.json().catch(() => ({}));
    if (!rec.ok) throw new Error(out.error || `HTTP ${rec.status}`);
    return { file: out.file };
  } finally {
    grid.close();
  }
}

/**
 * A queue that makes previews one at a time, in the background. Returns
 * `request(file, opts)`; `onReady(file)` receives the row, presigned, once
 * something new is recorded for it (fold it in with mergeBackfilled).
 *
 *   request(file)                    missing thumbnail
 *   request(file, { upgrade: true }) an old small thumbnail
 *   request(file, { sizes: true })   a thumbnail without siblings
 *   request(file, { blob })          the original, already fetched to show it
 *
 * They run in that order of priority — a tile with no picture at all matters
 * more than a soft one, and both more than bytes saved later.
 */
export function createThumbnailBackfill(onReady) {
  const seen = new Set();
  const queues = { missing: [], upgrade: [], sizes: [], blob: [] };
  const ORDER = ['missing', 'upgrade', 'sizes', 'blob'];
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
        if (mode === 'sizes') {
          const out = await makeSizes(file);
          if (out.file) onReady(out.file);
          else if (out.skip) rememberSkip(file.id, 'sizes');
          continue;
        }
        // Ask first whether this person may record a thumbnail for the file.
        // Library-wide write access is not per-file access: a member may see
        // plenty of files that others added. Without asking, each of those
        // cost a download of the original and two orphaned uploads before
        // the PUT was refused — and with old thumbnails being remade, that
        // was most of a shared library.
        const may = await fetch(`/api/files/${file.id}/thumbnail`, { cache: 'no-store' });
        if (!may.ok) { rememberSkip(file.id); continue; }
        const thumb = await makeThumbnail(blob || file.url, file);
        if (!thumb) { rememberSkip(file.id); continue; }
        const { key: thumbnailKey, posterKey, thumbSizes } = await uploadPreviews(thumb);
        const r = await fetch(`/api/files/${file.id}/thumbnail`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ thumbnailKey, posterKey, thumbSizes, media: thumb.media }),
        });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
        onReady(out.file);
      } catch {
        rememberSkip(file.id, mode === 'sizes' ? 'sizes' : undefined);
      }
    }
    running = false;
  }

  return (file, { upgrade = false, sizes = false, blob = null } = {}) => {
    if (!file?.id || file.storage !== 's3') return;
    const mode = blob ? 'blob' : sizes ? 'sizes' : upgrade ? 'upgrade' : 'missing';
    const tag = `${mode === 'sizes' ? 'sizes' : 'thumb'}:${file.id}`;
    if (seen.has(tag)) return;
    if (mode === 'sizes') {
      if (!file.thumbnailUrl || !isThumbKey(file.thumbnailKey) || file.thumbSizes?.length) return;
      if (saveData() || skippedRecently(file.id, 'sizes')) return;
    } else {
      if (!drawableKind(file, { probe: probedNow() }) || skippedRecently(file.id)) return;
      if (!blob && !file.url) return;
      // An original handed over for its preview, when there is one already, is not needed.
      if (blob && file.posterUrl) return;
      if (upgrade && saveData()) return;
    }
    seen.add(tag);
    queues[mode].push({ file, blob });
    if (!running) run();
  };
}
