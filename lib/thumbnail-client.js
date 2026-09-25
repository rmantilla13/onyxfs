// lib/thumbnail-client.js — thumbnails, made in the browser.
//
// The browser already has the file in hand at upload time and decodes JPEG,
// PNG, WebP, H.264 and VP9 natively, so it draws a small WebP there and puts
// it in the bucket beside the original. No ffmpeg or sharp in a serverless
// function, and nothing that has to download a multi-gigabyte master.
//
// Files uploaded before this existed get the same treatment lazily: when a
// tile without a thumbnail scrolls into view for someone who can edit it, the
// original is decoded from its presigned URL and the thumbnail recorded.
// Anything the browser cannot decode (HEIC, TIFF, ProRes, RAW) is skipped and
// keeps its typed placeholder.

import { putToBucket } from './multipart-client';
import { drawableKind, THUMB_SOURCE_MAX_BYTES } from './media';

const THUMB_MAX = 480;
const TIMEOUT_MS = 20000;
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

// Seek a tenth of the way in (at least a second, at most halfway) so the
// poster is a real frame rather than the black or slate that opens a clip.
function loadVideoFrame(src, remote, cleanup) {
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
      if (!v.videoWidth) { reject(new Error('No video track this browser can decode.')); return; }
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      v.onseeked = () => resolve({ el: v, width: v.videoWidth, height: v.videoHeight, duration: d });
      v.currentTime = d ? Math.min(Math.max(1, d * 0.1), d / 2) : 0.1;
    };
    v.src = src;
  });
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(
    (b) => (b ? resolve(b) : reject(new Error('Could not encode the thumbnail.'))), type, quality
  ));
}

async function draw({ el, width, height }) {
  const scale = Math.min(1, THUMB_MAX / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
  // A browser that cannot encode WebP hands back a PNG instead; JPEG is the
  // smaller fallback for a photo.
  const webp = await toBlob(canvas, 'image/webp', 0.78);
  return webp.type === 'image/webp' ? webp : toBlob(canvas, 'image/jpeg', 0.82);
}

/**
 * Draw a thumbnail of `file` ({ name, mime, size }) from `source`: a File or
 * Blob at upload time, or the original's presigned URL for a backfill.
 * Resolves { blob, media: { width, height, duration? } }, or null when the
 * format is not one a browser draws.
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
      return { blob: await draw(frame), media };
    })();
    work.catch(() => {}); // lost the race; its failure is not news
    return await Promise.race([work, timeout(TIMEOUT_MS)]);
  } finally {
    for (const fn of cleanup) fn();
  }
}

/** Put a thumbnail in the bucket under a key the server names. Resolves the key. */
export async function uploadThumbnail(blob) {
  const res = await fetch('/api/files/presign', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ thumb: true, contentType: blob.type }),
  });
  const pre = await res.json().catch(() => ({}));
  if (!res.ok || pre.error) throw new Error(pre.error || `Could not start the thumbnail upload (HTTP ${res.status}).`);
  await putToBucket(pre.putUrl, blob, {
    contentType: blob.type,
    headers: pre.cacheControl ? { 'cache-control': pre.cacheControl } : undefined,
  });
  return pre.key;
}

/**
 * The thumbnail for a file being uploaded: { key, media }, or null. Never
 * rejects — a file without a preview is still a file, and must still upload.
 */
export async function thumbnailForUpload(file) {
  try {
    const thumb = await makeThumbnail(file, { name: file.name, mime: file.type, size: file.size });
    if (!thumb) return null;
    return { key: await uploadThumbnail(thumb.blob), media: thumb.media };
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

/**
 * A queue that makes missing thumbnails one at a time, in the order tiles
 * came into view. Returns `request(file)`; `onReady(file)` receives the row,
 * presigned, once its thumbnail is recorded.
 */
export function createThumbnailBackfill(onReady) {
  const seen = new Set();
  const queue = [];
  let running = false;

  async function run() {
    running = true;
    while (queue.length) {
      const file = queue.shift();
      try {
        const thumb = await makeThumbnail(file.url, file);
        if (!thumb) { rememberSkip(file.id); continue; }
        const thumbnailKey = await uploadThumbnail(thumb.blob);
        const r = await fetch(`/api/files/${file.id}/thumbnail`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ thumbnailKey, media: thumb.media }),
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

  return (file) => {
    if (!file?.id || !file.url || file.storage !== 's3' || seen.has(file.id)) return;
    if (!drawableKind(file) || skippedRecently(file.id)) return;
    seen.add(file.id);
    queue.push(file);
    if (!running) run();
  };
}
