// lib/thumbs.js — server-side thumbnail worker.
//
// Generates grid previews so the browser never has to (the old client-side
// per-page-load backfill downloaded full files + decoded frames in every user's
// tab). Images use sharp; videos extract a frame with the bundled ffmpeg-static
// binary. Output is a small WebP stored under _thumbs/<id>.webp; the file row's
// thumbnail_key is set so reads presign it. Everything degrades gracefully —
// a failure marks the row 'error' (grid shows the kind-icon placeholder) and
// never throws into a request.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getStorageConfig, s3Ready, s3GetBytes, s3PutBytes } from './storage.js';
import { claimPendingThumbs, markThumbReady, markThumbStatus } from './db.js';

const execFileP = promisify(execFile);
const THUMB_MAX = 400;
const CONCURRENCY = 4;
const VIDEO_MAX_BYTES = 200 * 1024 * 1024; // protect /tmp + time on huge videos

let _sharp;
async function getSharp() { if (!_sharp) _sharp = (await import('sharp')).default; return _sharp; }

async function imageThumb(bytes) {
  const sharp = await getSharp();
  return sharp(bytes).rotate().resize(THUMB_MAX, THUMB_MAX, { fit: 'cover', withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
}

async function videoThumb(bytes) {
  const ffmpegPath = (await import('ffmpeg-static')).default;
  if (!ffmpegPath) throw new Error('ffmpeg binary unavailable');
  const dir = await mkdtemp(join(tmpdir(), 'onyx-thumb-'));
  const inPath = join(dir, 'in');
  const framePath = join(dir, 'frame.jpg');
  try {
    await writeFile(inPath, bytes);
    // Seek ~1s in and grab a single frame (fast; bounded by a hard timeout).
    await execFileP(ffmpegPath, ['-y', '-ss', '1', '-i', inPath, '-frames:v', '1', '-q:v', '3', framePath], { timeout: 60_000 });
    const frame = await readFile(framePath);
    const sharp = await getSharp();
    return sharp(frame).resize(THUMB_MAX, THUMB_MAX, { fit: 'cover', withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function generateOne(file, cfg) {
  if (file.kind === 'video' && file.size != null && Number(file.size) > VIDEO_MAX_BYTES) {
    await markThumbStatus(file.id, 'skip');
    return 'skip';
  }
  const bytes = await s3GetBytes(cfg, file.storageKey);
  let thumb;
  if (file.kind === 'image') thumb = await imageThumb(bytes);
  else if (file.kind === 'video') thumb = await videoThumb(bytes);
  else { await markThumbStatus(file.id, 'skip'); return 'skip'; }
  const key = `_thumbs/${file.id}.webp`;
  await s3PutBytes(cfg, key, thumb, 'image/webp');
  await markThumbReady(file.id, key, null); // thumbnail_url presigned on read
  return 'ok';
}

/** Drain the pending-thumbnail queue in bounded-parallel batches until empty or
 *  the time budget is hit. Safe to run concurrently (atomic claim). */
export async function drainThumbs({ maxMs = 230_000 } = {}) {
  const cfg = await getStorageConfig();
  if (!s3Ready(cfg)) return { processed: 0, errored: 0, skipped: 0, note: 's3-not-configured' };
  const start = Date.now();
  let processed = 0, errored = 0, skipped = 0;
  while (Date.now() - start < maxMs) {
    const batch = await claimPendingThumbs(CONCURRENCY);
    if (!batch.length) break;
    const results = await Promise.all(batch.map(async (f) => {
      try { return await generateOne(f, cfg); }
      catch (e) { console.warn('[thumb] failed', f.id, e?.message); await markThumbStatus(f.id, 'error'); return 'err'; }
    }));
    for (const r of results) { if (r === 'ok') processed++; else if (r === 'skip') skipped++; else errored++; }
  }
  return { processed, errored, skipped };
}
