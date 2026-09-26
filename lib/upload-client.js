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

import { uploadFileMultipart, putToBucket, abortUpload } from './multipart-client';
import { thumbnailForUpload } from './thumbnail-client';
import { filmstripForUpload } from './filmstrip-client';
import { probeMp4, blobReader, probeMetadata } from './mp4-probe';
import { fileKind } from './media';

// Above this, a single presigned PUT is a bad bet: S3 refuses past 5 GB, and
// well before that a dropped connection costs the whole transfer. Multipart
// parts are independently retryable and the upload survives a reload.
export const MULTIPART_THRESHOLD = 32 * 1024 * 1024;

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

async function upload(file, { folder, filespaceId, signal, onProgress, resumeId, onResumable }) {
  const cfg = await storageConfig();
  // Drawn while the original uploads, and recorded with it, so the tile has
  // its preview the moment the grid refreshes.
  const thumb = cfg.mode === 's3' ? thumbnailForUpload(file) : Promise.resolve(null);
  // The hover-scrub sheet, started alongside the poster and awaited with it.
  // Both decode the same local file, so they are not raced against each other:
  // forty seeks competing with a poster seek on one <video> is slower than
  // doing them in sequence, and makeFilmstrip creates its own element anyway.
  // Either resolving to null is normal — neither is allowed to fail an upload.
  const strip = cfg.mode === 's3' ? filmstripForUpload(file) : Promise.resolve(null);
  // The frame model — exact rate, frame count, start timecode — from the
  // container, which the browser will not tell us. A few small reads of the
  // local file; a format it cannot read, or a failed read, is simply no model,
  // and the upload goes on without one.
  const frames = fileKind(file.type, file.name) === 'video'
    ? probeMp4(blobReader(file), { size: file.size }).then(probeMetadata, () => ({}))
    : Promise.resolve({});
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
  // library once this row is written.
  const preview = await thumb;
  const filmstrip = await strip;
  const media = { ...(preview?.media || {}), ...(await frames) };
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
      media: Object.keys(media).length ? media : undefined,
      filmstripKey: filmstrip?.key,
      filmstrip: filmstrip?.filmstrip,
    }),
  });
  const body = await saved.json().catch(() => ({}));
  if (!saved.ok) throw new Error(`Uploaded, but it could not be added to the library: ${body.error || `HTTP ${saved.status}`}`);
  return body.file;
}

export { joinFolder, filesFromDrop, filesFromInput, createUploadQueue } from './upload-queue.js';
