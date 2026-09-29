// lib/upload-client.js — the web uploader: one file, a queue of them, and the
// files inside a dropped folder.
//
// Framework-free, like multipart-client.js. The library page renders the
// queue's snapshots; everything that decides what happens lives here.
//
// The queue and the drop/input helpers are in lib/upload-queue.js, which the
// files page loads with itself; this module — the transfer, and the
// thumbnail, filmstrip and probe code it pulls in — is loaded when an upload
// actually starts, so someone who only looks at files never downloads it.

import { uploadFileMultipart, putToBucket, abortUpload, slots } from './multipart-client';
import { thumbnailForUpload, attachThumbnail, thumbnailFromUpload } from './thumbnail-client';
import { filmstripForUpload, attachFilmstrip } from './filmstrip-client';
import { probeMp4, blobReader, probeMetadata } from './mp4-probe';
import { photoCaptureDate } from './capture-date';
import { fileKind } from './media';
import { waveformForUpload, recordWaveform } from './waveform-client';

// Above this, a single presigned PUT is a bad bet: S3 refuses past 5 GB, and
// well before that a dropped connection costs the whole transfer. Multipart
// parts are independently retryable and the upload survives a reload.
export const MULTIPART_THRESHOLD = 32 * 1024 * 1024;

// How long a file whose bytes have landed waits for previews still being
// drawn before it is recorded without them. A thumbnail started with the
// transfer is almost always done by then; one that is not — a filmstrip's
// forty seeks, a long video's poster — is attached to the row once it is
// (attachLater), and the file is in the library meanwhile, its place in the
// upload queue free for the next one.
export const PREVIEW_WAIT_MS = 1500;

// Previews drawn at once, across the page's uploads. The queue moves on as
// each file is recorded, so however far the transfers run ahead of the
// drawing, the decoding stays at what three uploads at a time used to ask.
const thumbnails = slots(3);
const filmstrips = slots(3);

/**
 * What `work` resolves to if it does within `ms`, else null — `work` goes on
 * regardless. Never rejects.
 */
export function readyWithin(work, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(work).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Once `work` resolves to something, `attach` it: a preview that was not
 * ready when its file was recorded. Resolves what `attach` does, or null —
 * nothing came, or attaching it failed. Never rejects: a preview is never
 * worth an error for a file that is already in the library.
 */
export function attachLater(work, attach) {
  return Promise.resolve(work)
    .then((value) => (value ? attach(value) : null))
    .catch(() => null);
}

// A preview still on its way when the page is left is lost: a filmstrip for
// good, since one is only ever made at upload, and a thumbnail until an
// editor's browser downloads the original to draw it. So while any is, the
// page asks before it is left, as it does mid-upload (app/files/FilesClient.js).
let attaching = 0;
const askFirst = (e) => { e.preventDefault(); e.returnValue = ''; };
function whileAttaching(work) {
  if (typeof window === 'undefined') return work;
  if (attaching++ === 0) window.addEventListener('beforeunload', askFirst);
  return work.finally(() => { if (--attaching === 0 && typeof window !== 'undefined') window.removeEventListener('beforeunload', askFirst); });
}

let configPromise = null;
/** The storage mode, fetched once per page and again after a failure. */
function storageConfig() {
  configPromise ||= fetch('/api/files/config')
    .then(async (r) => {
      const cfg = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(cfg.error || `HTTP ${r.status}`);
      return cfg;
    })
    .catch((e) => {
      configPromise = null;
      // Falling back to Blob sent every upload down a path the deployment
      // was not configured for, with an error about Blob.
      throw new Error(`Could not read the storage settings (${e.message}). Nothing was uploaded.`);
    });
  return configPromise;
}

/**
 * Upload one file into `folder` and record it. Resolves the saved row.
 * `onProgress(sent, total)` reports bytes; `onResumable(id)` hands back a
 * multipart upload id so a retry can continue instead of starting over.
 * `onPreview(row)` is handed the row, signed, each time a preview that was
 * not ready when it was recorded is attached to it afterwards.
 */
export async function uploadOne(file, opts) {
  try {
    return await upload(file, opts);
  } catch (e) {
    // fetch reports a dropped connection as a bare TypeError ("Failed to
    // fetch"), which says nothing about what to do next.
    if (e instanceof TypeError && /fetch|network|load failed/i.test(e.message) && !opts.signal?.aborted) {
      throw new Error('The connection dropped before this file finished. Check the network and retry.');
    }
    throw e;
  }
}

/**
 * { duration } of a local audio file, as this browser's own player reads it:
 * only the header, never the whole file. Nothing for a format it cannot
 * play, or after a few seconds — an upload never waits on it for long, and
 * never fails for it. The server checks the number (lib/media.js mediaFacts).
 */
const AUDIO_PROBE_MS = 4000;
export function audioLength(file) {
  if (typeof Audio === 'undefined' || typeof URL?.createObjectURL !== 'function') return Promise.resolve({});
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = new Audio();
    let timer = null;
    const finish = (media) => {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      el.onloadedmetadata = null;
      el.onerror = null;
      el.removeAttribute('src');
      URL.revokeObjectURL(url);
      resolve(media);
    };
    timer = setTimeout(() => finish({}), AUDIO_PROBE_MS);
    el.preload = 'metadata';
    el.onloadedmetadata = () => finish(Number.isFinite(el.duration) && el.duration > 0 ? { duration: el.duration } : {});
    el.onerror = () => finish({});
    el.src = url;
  });
}

async function upload(file, { folder, filespaceId, signal, onProgress, resumeId, onResumable, onPreview }) {
  const cfg = await storageConfig();
  // Drawn while the original uploads, and recorded with it when ready in
  // time, so the tile has its preview the moment the grid refreshes. Each
  // waits for a slot of its own (`thumbnails`, `filmstrips`); an upload
  // cancelled first draws nothing.
  const thumb = cfg.mode === 's3'
    ? thumbnails.run(() => thumbnailForUpload(file), signal).catch(() => null)
    : Promise.resolve(null);
  // The hover-scrub sheet, started alongside the poster. Both decode the same
  // local file, each on a <video> of its own. Either resolving to null is
  // normal — neither is allowed to fail an upload.
  const strip = cfg.mode === 's3'
    ? filmstrips.run(() => filmstripForUpload(file), signal).catch(() => null)
    : Promise.resolve(null);
  // The frame model — exact rate, frame count, start timecode — from the
  // container, which the browser will not tell us. A few small reads of the
  // local file; a format it cannot read, or a failed read, is simply no model,
  // and the upload goes on without one.
  // An audio file has no picture to read its length from, so the browser is
  // asked for it the same way — the Audio view's Duration column.
  const kind = fileKind(file.type, file.name);
  const probe = kind === 'video'
    ? probeMp4(blobReader(file), { size: file.size }).catch(() => null)
    : Promise.resolve(null);
  const frames = kind === 'video'
    ? probe.then(probeMetadata)
    : kind === 'audio' ? audioLength(file) : Promise.resolve({});
  // A sound's shape (lib/waveform-client.js), drawn from the file in hand
  // while its bytes go up. Its length, read just above, decides whether a
  // compressed one is short enough to decode here.
  const wave = kind === 'audio' && cfg.mode === 's3'
    ? frames.then((m) => waveformForUpload(file, { duration: m?.duration }))
    : Promise.resolve(null);
  // When it was shot: a video's from the same probe (its mvhd), a photo's
  // from its EXIF (lib/capture-date.js), two or three small reads more. The
  // file's own created date; the browser knows no other. None is fine.
  const captured = kind === 'video'
    ? probe.then((p) => p?.createdAt ?? null)
    : kind === 'image'
      ? photoCaptureDate(blobReader(file), { size: file.size }).catch(() => null)
      : Promise.resolve(null);
  let url;
  let storage;
  let storageKey;
  let name = file.name;

  if (cfg.mode === 's3' && file.size > MULTIPART_THRESHOLD) {
    let uploadId = resumeId || null;
    try {
      const done = await uploadFileMultipart(file, {
        folder,
        filespaceId: filespaceId || undefined,
        resumeId: resumeId || null,
        signal,
        onStart: ({ id }) => { uploadId = id; onResumable?.(id); },
        onProgress: ({ uploaded, total }) => onProgress?.(uploaded, total),
      });
      url = done.publicUrl;
      storageKey = done.key;
      name = done.name || name;
    } catch (e) {
      // A cancel discards the parts; a failure keeps them for a retry.
      if (signal?.aborted && uploadId) abortUpload(uploadId).catch(() => {});
      throw e;
    }
    storage = 's3';
  } else if (cfg.mode === 's3') {
    const res = await fetch('/api/files/presign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        // Required: the server checks it against the largest upload and the
        // quota before it signs anything, and again against the bucket's
        // own HEAD when the file is recorded.
        size: file.size,
        folder,
        filespaceId: filespaceId || undefined,
      }),
    });
    const pre = await res.json().catch(() => ({}));
    if (!res.ok || pre.error) throw new Error(pre.error || `Could not start the upload (HTTP ${res.status}).`);
    await putToBucket(pre.putUrl, file, {
      contentType: file.type || 'application/octet-stream',
      signal,
      onProgress,
    });
    url = pre.publicUrl;
    storage = 's3';
    storageKey = pre.key;
    name = pre.name || name;
  } else {
    const { upload: blobUpload } = await import('@vercel/blob/client');
    const blob = await blobUpload(file.name, file, {
      access: 'public',
      handleUploadUrl: '/api/files/upload',
      abortSignal: signal,
    });
    url = blob.url;
    storage = 'blob';
  }

  // The bytes are in the bucket at this point; a file only exists in the
  // library once this row is written — so it is written now, with the
  // previews that are ready within PREVIEW_WAIT_MS. Waiting for all of them
  // held a file out of the library, and its slot in the queue, for as long
  // as its filmstrip took: up to 45 seconds. What is not ready is attached
  // below, once it is.
  // A sound's waveform likewise: drawn alongside the transfer, and nearly
  // always done by now; one queued behind another upload's decode is
  // attached once it is.
  const [preview, filmstrip, waveform] = await Promise.all([
    readyWithin(thumb, PREVIEW_WAIT_MS), readyWithin(strip, PREVIEW_WAIT_MS), readyWithin(wave, PREVIEW_WAIT_MS),
  ]);
  const media = { ...(preview?.media || {}), ...(await frames) };
  const fileCreatedAt = await captured;
  const saved = await fetch('/api/files', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      url,
      mime: file.type,
      size: file.size,
      folder,
      storage,
      storageKey,
      filespace: filespaceId || undefined,
      thumbnailKey: preview?.key,
      posterKey: preview?.posterKey || undefined,
      thumbSizes: preview?.thumbSizes?.length ? preview.thumbSizes : undefined,
      placeholder: preview?.placeholder || undefined,
      media: Object.keys(media).length ? media : undefined,
      filmstripKey: filmstrip?.key,
      filmstrip: filmstrip?.filmstrip,
      waveform: waveform || undefined,
      // The file's own dates, which the server keeps beside when it was
      // added: lastModified for every file, the capture date where there is one.
      fileCreatedAt: fileCreatedAt || undefined,
      fileModifiedAt: file.lastModified || undefined,
    }),
  });
  const body = await saved.json().catch(() => ({}));
  if (!saved.ok) throw new Error(`Uploaded, but it could not be added to the library: ${body.error || `HTTP ${saved.status}`}`);
  // The previews that missed the row, attached as each is done — after this
  // returns, so the queue does not wait for them. The thumbnail is noted as
  // coming (thumbnailFromUpload), so a tile shown without it meanwhile does
  // not have the backfill draw a second. A late waveform does not hold the
  // page open as the pictures do: a sound without one is drawn again by the
  // next editor's browser that shows it (lib/waveform-client.js).
  const row = body.file;
  if (row?.id && cfg.mode === 's3') {
    const attached = (f) => {
      try { if (f) onPreview?.(f); } catch { /* the page's own; the preview is recorded */ }
      return f;
    };
    if (!preview) thumbnailFromUpload(row.id, whileAttaching(attachLater(thumb, (p) => attachThumbnail(row, p))).then(attached));
    if (!filmstrip) whileAttaching(attachLater(strip, (s) => attachFilmstrip(row, s))).then(attached);
    if (!waveform && kind === 'audio') attachLater(wave, (w) => recordWaveform(row, w)).then(attached);
  }
  return row;
}

export { joinFolder, filesFromDrop, filesFromInput, createUploadQueue } from './upload-queue.js';
