// lib/frame-probe.js — reading a stored video's frame model (exact rate,
// frame count, start timecode) from its container and recording it on the
// row. Shared by the detail page's one-file backfill (POST
// /api/files/[id]/probe) and Admin → Usage's "Probe all videos" (POST
// /api/admin/storage/probe). Node only: it reaches lib/db.js.
//
// Only the container's headers are read, through a few range requests
// (lib/mp4-probe.js) — never the media. The result is recorded without
// touching the file's version or Modified date (setFileFrameModel). Neither
// caller authorizes here: each has already decided the file may be read and
// changed before asking for a URL to it.

import { setFileFrameModel } from './db.js';
import { getStorageConfig, storageMode, s3PresignGet } from './storage.js';
import { storageForKeys } from './drive-storage.js';
import { mediaFacts } from './media.js';
import { probeMp4, probeMetadata, rangeReader } from './mp4-probe.js';

// Long enough for a slow bucket to answer a handful of small range requests,
// short enough that a backfill never hangs a lambda.
const READ_TIMEOUT_MS = 10_000;

// Vercel Blob's public stores. A Blob row's url is whatever the uploader
// recorded, so it is fetched only when it points at one of these.
const BLOB_HOST = /(^|\.)blob\.vercel-storage\.com$/;

/**
 * How to find a readable URL for a file: resolves the storage configuration
 * once (the deployment's, and each drive with keys of its own), so a loop
 * over many files does not look it up per file. `sourceFor(file)` is then the
 * URL, or null.
 *
 * Never simply the row's `url`: for a Blob row that is whatever the client
 * sent when it recorded the upload, and fetching it would let anyone who can
 * add a file make the server request any address it likes. An S3 row is
 * signed afresh from its storage key against the bucket that holds it (the
 * CDN shortcut in presignFileUrls hands back the stored url, so it is not
 * used); a Blob row is read only from Vercel Blob itself.
 */
export async function frameSources() {
  const cfg = await getStorageConfig();
  const s3 = storageMode(cfg) === 's3';
  const cfgFor = s3 ? await storageForKeys(cfg) : null;
  return {
    async sourceFor(file) {
      if (file.storage === 's3' && file.storageKey) {
        if (!s3) return null;
        return s3PresignGet(cfgFor(file.storageKey), file.storageKey, { expiresIn: 600 });
      }
      if (file.storage === 'blob') {
        try {
          const u = new URL(file.url);
          if (u.protocol === 'https:' && BLOB_HOST.test(u.hostname)) return u.href;
        } catch { /* not a URL at all */ }
      }
      return null;
    },
  };
}

/**
 * Read `file`'s frame model and record it. Returns one of:
 *
 *   { state: 'found', metadata }       the rate (and the rest) recorded
 *   { state: 'unreadable', metadata }  read, and no rate in it (WebM, a
 *                                      fragmented MP4 with no sample table):
 *                                      marked fpsUnknown, so it is not tried
 *                                      again on every visit
 *   { state: 'nosource' }              not in storage the server can read
 *   { state: 'failed', error }         the read itself failed. That says
 *                                      nothing about the file, so nothing is
 *                                      recorded: try again another time
 *
 * `sources` is frameSources()'s, passed in by a caller probing many files.
 */
export async function probeFrameModel(file, { sources } = {}) {
  const src = sources || await frameSources();
  const url = await src.sourceFor(file).catch(() => null);
  if (!url) return { state: 'nosource' };

  let probe;
  try {
    const { readRange, size } = await rangeReader(url, {
      fetchImpl: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(READ_TIMEOUT_MS) }),
    });
    probe = await probeMp4(readRange, { size });
  } catch (e) {
    return { state: 'failed', error: e.message || 'the read failed' };
  }

  const md = file.metadata || {};
  const facts = mediaFacts(probeMetadata(probe));
  if (!facts.fps) {
    const updated = await setFileFrameModel(file.id, { fpsUnknown: true });
    return { state: 'unreadable', metadata: updated?.metadata || { ...md, fpsUnknown: true } };
  }
  // The browser's width, height and duration are what the rest of the app
  // uses; the container's fill in only where the row has none.
  const fallback = mediaFacts({ width: probe.width, height: probe.height, duration: probe.duration });
  const updated = await setFileFrameModel(file.id, { ...facts, fpsUnknown: false }, fallback);
  return { state: 'found', metadata: updated?.metadata || { ...md, ...facts } };
}
