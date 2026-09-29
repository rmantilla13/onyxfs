// lib/download-client.js — making a "Download as…" copy in the browser, and
// handing it to the browser to save. Loaded by the dialog when a copy is asked
// for (app/components/download/DownloadAs.js), never with the page.
//
// A picture: the original is fetched from its signed address (the bucket's
// CORS rule allows GET — lib/storage-cors.js), past the HTTP cache, since a
// copy an <img> left there has no CORS headers and could not be read. It is
// decoded, turned, scaled and encoded in a worker (lib/image-convert.worker.js)
// so the page never stalls on a 24-megapixel decode; where there is no worker
// canvas, or the worker cannot decode the format (a HEIC only an <img> opens),
// the same code runs on the page (lib/image-convert.js), between frames.
//
// A still frame: drawn from a <video> of our own at the player's time —
// crossOrigin, so the canvas is not tainted (the player's own element is not,
// and cannot be read) — then encoded the same way.
//
// Saving: an object URL and an <a download>. The URL is kept for a while
// rather than revoked after the click: WebKit reads the blob after the click
// has been handed on, and in Onyx for Mac the download is the app's
// (apple/OnyxMac/Downloads.swift adopts a WKDownload once the web view's
// navigation delegate has decided on it, asynchronously) — a URL revoked in
// between is a download that fails, and "a blob the page made is gone" there,
// so it cannot be retried.

import { convertBlob, renderPicture, decodeBitmap, ConvertError } from './image-convert.js';
import { CONVERT_MAX_BYTES } from './download-formats.js';
import { maxCanvasPixels } from './download-probe.js';
import { preloaded } from './original-preload.js';
import { frameVideo } from './frame-video.js';
import { coverTime } from './poster.js';

/** How long an object URL handed to a download is kept before it is revoked. */
export const REVOKE_AFTER_MS = 2 * 60 * 1000;
// A video that has not loaded or seeked by now is not going to.
const VIDEO_TIMEOUT_MS = 30000;

const aborted = () => new DOMException('The download was cancelled.', 'AbortError');
export const isAbort = (e) => e?.name === 'AbortError';

class FetchError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'FetchError';
    this.status = status;
  }
}

/** `src` as a Blob, with progress (0..1, or null while the length is unknown). Refuses past `maxBytes`. */
async function fetchPicture(src, { signal, onProgress, maxBytes }) {
  // Quick Look loads a neighbour's original ahead the same way (lib/original-preload.js).
  const ahead = preloaded(src);
  if (ahead) {
    try {
      const blob = await ahead;
      if (blob.size <= maxBytes) return blob;
    } catch { /* fetched afresh below */ }
  }
  let r;
  try {
    r = await fetch(src, { mode: 'cors', cache: 'no-store', signal });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new FetchError(0, 'The original could not be read from storage. Try again, or download the original.');
  }
  if (!r.ok) throw new FetchError(r.status, `The original could not be read (HTTP ${r.status}).`);
  const total = Number(r.headers.get('content-length')) || 0;
  const tooBig = () => new FetchError(413, 'This file is too large to convert in the browser. Download the original instead.');
  if (total > maxBytes) {
    try { await r.body?.cancel(); } catch { /* already closed */ }
    throw tooBig();
  }
  const type = r.headers.get('content-type') || '';
  if (!r.body) return r.blob();
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (got > maxBytes) {
      try { await reader.cancel(); } catch { /* gone */ }
      throw tooBig();
    }
    chunks.push(value);
    onProgress?.(total ? Math.min(1, got / total) : null);
  }
  return new Blob(chunks, { type });
}

/** fetchPicture, signed again once through `refresh` when the address has expired (a tab left open for hours). */
async function fetchFresh(src, { refresh, ...opts }) {
  try {
    return await fetchPicture(src, opts);
  } catch (e) {
    if (!(e instanceof FetchError) || (e.status !== 403 && e.status !== 400) || !refresh) throw e;
    const again = await refresh().catch(() => null);
    if (!again || again === src) throw e;
    return fetchPicture(again, opts);
  }
}

// ── Where the work runs ─────────────────────────────────────────────────────

/** One job in a worker of its own, terminated when it answers or is cancelled. */
function inWorker(message, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(aborted()); return; }
    let worker;
    try {
      worker = new Worker(new URL('./image-convert.worker.js', import.meta.url));
    } catch {
      reject(new ConvertError('unsupported', 'No worker here.'));
      return;
    }
    const finish = () => {
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => { finish(); reject(aborted()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = ({ data }) => {
      finish();
      if (data?.ok) resolve(data);
      else reject(new ConvertError(data?.code || 'decode', data?.message || 'The conversion failed.'));
    };
    // A worker that fails to load, or dies (out of memory, say).
    worker.onerror = (ev) => {
      ev?.preventDefault?.();
      finish();
      reject(new ConvertError('unsupported', 'The converter stopped.'));
    };
    try {
      worker.postMessage(message);
    } catch {
      finish();
      reject(new ConvertError('unsupported', 'This could not be handed to the converter.'));
    }
  });
}

const nextFrame = () => new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 16)));

/** Decode on the page: createImageBitmap, else an <img> — which opens what only it can (a HEIC in Safari). */
async function pageDecode(blob) {
  if (typeof createImageBitmap === 'function') {
    try { return await decodeBitmap(blob); } catch { /* try an <img> */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // A decoded <img> keeps its pixels; the address is not needed again.
    URL.revokeObjectURL(url);
  }
}

const pageEnv = {
  decode: pageDecode,
  canvas: (width, height) => {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  },
  encode: (canvas, type, quality) => new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), type, quality);
  }),
};

/** `work` on the page, a frame after the progress was painted; its answer is dropped if cancelled meanwhile. */
async function onPage(work, signal) {
  await nextFrame();
  if (signal?.aborted) throw aborted();
  const out = await work();
  if (signal?.aborted) throw aborted();
  return out;
}

/** In a worker; on the page when the worker cannot (anything but a size this browser cannot hold, or a cancel). */
async function convert(message, pageWork, signal) {
  try {
    return await inWorker(message, signal);
  } catch (e) {
    if (isAbort(e) || e?.code === 'pixels') throw e;
    return onPage(pageWork, signal);
  }
}

// ── Pictures ────────────────────────────────────────────────────────────────

/**
 * The picture at `src` as `format` (an IMAGE_FORMATS entry) at `longEdge`
 * (null: full size). `onProgress({ phase, fraction })`: 'fetch' with how much
 * has arrived, then 'convert'. `refresh()` resolves a newly signed `src`.
 * Resolves { blob, width, height, source } — `source` the picture's own size.
 */
export async function convertImage({ src, format, longEdge = null, signal, onProgress, refresh, maxBytes = CONVERT_MAX_BYTES }) {
  onProgress?.({ phase: 'fetch', fraction: 0 });
  const blob = await fetchFresh(src, { signal, refresh, maxBytes, onProgress: (fraction) => onProgress?.({ phase: 'fetch', fraction }) });
  if (signal?.aborted) throw aborted();
  onProgress?.({ phase: 'convert', fraction: null });
  const maxPixels = maxCanvasPixels();
  return convert(
    { blob, format, longEdge, maxPixels },
    () => convertBlob(blob, { format, longEdge, maxPixels, env: pageEnv }),
    signal,
  );
}

// ── Still frames ────────────────────────────────────────────────────────────

function once(target, ok, { signal, error = 'error', timeout = VIDEO_TIMEOUT_MS, message }) {
  return new Promise((resolve, reject) => {
    const done = (fn, v) => {
      clearTimeout(timer);
      target.removeEventListener(ok, onOk);
      target.removeEventListener(error, onErr);
      signal?.removeEventListener('abort', onAbort);
      fn(v);
    };
    const onOk = () => done(resolve);
    const onErr = () => done(reject, new Error(message));
    const onAbort = () => done(reject, aborted());
    const timer = setTimeout(() => done(reject, new Error(message)), timeout);
    target.addEventListener(ok, onOk);
    target.addEventListener(error, onErr);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The frame of the video at `src` at `time` seconds, as { bitmap | canvas,
 * width, height }. Our own element, in the page (WebKit paints a video only
 * there — lib/frame-video.js) and crossOrigin, so what it draws can be read.
 */
async function grabFrame(src, time, signal) {
  const cleanup = [];
  try {
    const v = frameVideo(cleanup);
    v.crossOrigin = 'anonymous';
    v.preload = 'auto';
    const loaded = once(v, 'loadedmetadata', { signal, message: 'This video could not be opened to read a frame. Try the cover, or download the original.' });
    v.src = src;
    await loaded;
    if (!v.videoWidth || !v.videoHeight) throw new Error('This video has no picture this browser can read.');
    const at = coverTime(time, Number.isFinite(v.duration) ? v.duration : 0);
    const seeked = once(v, 'seeked', { signal, message: 'The frame could not be found in this video.' });
    v.currentTime = at;
    await seeked;
    // `seeked` is the seek, not necessarily its frame decoded: a moment for it.
    if (typeof v.requestVideoFrameCallback === 'function') {
      await Promise.race([new Promise((r) => v.requestVideoFrameCallback(() => r())), new Promise((r) => setTimeout(r, 250))]);
    }
    const width = v.videoWidth;
    const height = v.videoHeight;
    if (typeof createImageBitmap === 'function') {
      try { return { bitmap: await createImageBitmap(v), width, height }; } catch { /* drawn below */ }
    }
    const canvas = pageEnv.canvas(width, height);
    canvas.getContext('2d').drawImage(v, 0, 0, width, height);
    return { canvas, width, height };
  } finally {
    for (const fn of cleanup) { try { fn(); } catch { /* already gone */ } }
  }
}

/**
 * A still of the video at `src`, at `time` seconds, as `format`, full size.
 * Resolves { blob, width, height, source }.
 */
export async function frameStill({ src, time = 0, format, signal, onProgress }) {
  onProgress?.({ phase: 'frame', fraction: null });
  const frame = await grabFrame(src, time, signal);
  try {
    if (signal?.aborted) throw aborted();
    onProgress?.({ phase: 'convert', fraction: null });
    const maxPixels = maxCanvasPixels();
    const source = frame.bitmap || frame.canvas;
    const size = { width: frame.width, height: frame.height };
    const onThisPage = () => renderPicture(source, size, { format, maxPixels, env: pageEnv });
    // A bitmap goes to the worker as a copy, so the page still has it if
    // the worker cannot finish; a canvas is drawn from here.
    if (!frame.bitmap) return await onPage(onThisPage, signal);
    return await convert({ bitmap: frame.bitmap, ...size, format, maxPixels }, onThisPage, signal);
  } finally {
    frame.bitmap?.close?.();
    if (frame.canvas) { frame.canvas.width = 0; frame.canvas.height = 0; }
  }
}

// ── Saving ──────────────────────────────────────────────────────────────────

/**
 * Save `blob` as `filename`: an object URL clicked through an <a download>.
 * `container` holds the link while it is clicked — the open dialog, since
 * behind a modal one the page is inert. The URL is revoked REVOKE_AFTER_MS
 * later, not at once (see the top of this file).
 */
export function saveBlob(blob, filename, { container = null } = {}) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  (container || document.body).appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  return url;
}
