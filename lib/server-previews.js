// lib/server-previews.js — previews the server draws itself.
//
// A browser draws a file's thumbnail as it uploads it, a Mac as it syncs a
// drive, and a browser again in the background when an editor has the folder
// open. What none of them reach waits for ever: an image uploaded from a
// phone, one too big for a tab (THUMB_SOURCE_MAX_BYTES), one in a folder no
// editor opens. The previews cron (app/api/cron/previews) claims those a few
// at a time (lib/db.js claimServerPreviews) and draws them here, with sharp —
// the same set a browser makes (lib/thumbnail-client.js): the grid
// thumbnail, its sm and xs siblings, the large preview, and the blur
// placeholder, at the sizes lib/poster.js gives every client.
//
// A picture whose thumbnail came without its large preview — made before
// there were any, or by a browser or a Mac that left it out — opens from its
// original wherever it is shown large: Quick Look, the file page, the
// iPhone, tens of megabytes at a time. Once nothing waits for a thumbnail,
// a run claims those too (lib/db.js claimServerPosters) and draws the large
// preview alone (drawServerPoster): the thumbnail, its siblings and its
// placeholder stay as they are.
//
// The original is read to a temporary file, never held in memory, and
// decoded once, upright, to the largest size wanted; each smaller one is
// made from that. sharp reads a JPEG at a fraction of its size when it can
// (shrink-on-load) and the rest in one pass (sequentialRead), so a picture of
// hundreds of megabytes costs about what its output does — up to a pixel
// limit (MAX_INPUT_PIXELS), past which it is the Mac's (ImageIO subsamples).

import { createWriteStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import {
  gridPosterSize, thumbSiblingSizes, imagePreviewFor, WEBP_QUALITY, PREVIEW_WEBP_QUALITY,
} from './poster.js';
import { placeholderSize, PLACEHOLDER_QUALITY, placeholderFacts } from './placeholder.js';
import { thumbSiblingKey, PREVIEW_CACHE_CONTROL } from './media.js';
import { imageMime } from './preview-wanted.js';

// What one run may take on: Vercel's /tmp holds 512 MB, and the file goes
// there whole. So may every draw in the process together (claimOriginal):
// the two workers, and the runs Fluid compute may put on one instance,
// share its /tmp.
export const SERVER_PREVIEW_MAX_BYTES = 450 * 1024 * 1024;
// 16384 x 16384, as a browser's canvas (lib/download-formats.js
// MAX_CANVAS_PIXELS) and the Mac's ImageIO limit allow.
export const MAX_INPUT_PIXELS = 16384 * 16384;
// A pixel limit is not a memory one. sharp decodes a picture whole when it
// cannot read it a strip at a time — interlaced, progressive, turned by its
// EXIF orientation — and near MAX_INPUT_PIXELS that is gigabytes: 1.5 GB in
// 16-bit RGB. Two of those at once, from the two workers or from runs
// sharing an instance, would not fit in the function's 3 GB, so a picture
// that decodes to more than this waits for any other such one to finish
// (decodeInTurn). One of them beside an ordinary draw does fit.
export const HEAVY_DECODE_BYTES = 512 * 1024 * 1024;
// No run outlives maxDuration (300 s); a directory of ours older than this
// was left by one killed before its finally, with an original in it.
const STALE_TMP_MS = 10 * 60_000;

/** The sizes to make for a picture of `source` ({ width, height }, upright), as lib/thumbnail-client.js makes them. */
export function previewPlan(source, { bytes, mime } = {}) {
  const grid = gridPosterSize(source);
  if (!grid) return null;
  return {
    grid,
    siblings: thumbSiblingSizes(source),
    preview: imagePreviewFor(source, { bytes, mime }),
    placeholder: placeholderSize(source),
  };
}

/** Width and height as shown: EXIF orientations 5–8 turn the picture a quarter. */
export function uprightSize(meta) {
  const w = Number(meta?.width);
  const h = Number(meta?.height);
  if (!(w > 0) || !(h > 0)) return null;
  return Number(meta?.orientation) >= 5 ? { width: h, height: w } : { width: w, height: h };
}

/** What `meta`'s pixels come to decoded whole: every channel, at sharp's sample size. */
export function decodedBytes(meta) {
  const sample = { short: 2, ushort: 2, int: 4, uint: 4, float: 4, complex: 8, double: 8, dpcomplex: 16 }[meta?.depth] || 1;
  return (Number(meta?.width) || 0) * (Number(meta?.height) || 0) * (Number(meta?.channels) || 3) * sample;
}

let heavyDecodes = Promise.resolve();
/** `decode()`, after every heavy one this process began before it — at once when it is not `heavy`. */
async function decodeInTurn(heavy, decode) {
  if (!heavy) return decode();
  const before = heavyDecodes;
  let done;
  heavyDecodes = new Promise((resolve) => { done = resolve; });
  try {
    await before;
    return await decode();
  } finally {
    done();
  }
}

/**
 * Read `file`'s original to a file in `dir` and open it: its size as shown
 * (`source`), `open()`, a fresh sharp of it at each call, and whether its
 * decode is `heavy`. Throws with a sentence for an original the server will
 * not draw — carrying its `source` when that is its pixels, so its size can
 * be recorded and the original not read again for the same answer.
 */
async function openOriginal(file, io, dir) {
  const original = join(dir, 'original');
  await io.read(file, original);
  const size = (await stat(original)).size;
  if (size > SERVER_PREVIEW_MAX_BYTES) throw new Error('Too big to draw on the server.');

  const options = { sequentialRead: true, failOn: 'none', pages: 1 };
  const open = () => io.sharp(original, { ...options, limitInputPixels: MAX_INPUT_PIXELS });
  // The header past sharp's pixel limit, which it applies even to that: a
  // picture over the limit would otherwise fail with its size unread.
  const meta = await io.sharp(original, { ...options, limitInputPixels: false }).metadata();
  const source = uprightSize(meta);
  if (!source) throw new Error('The picture has no size sharp can read.');
  if (source.width * source.height > MAX_INPUT_PIXELS) {
    throw Object.assign(new Error('Too many pixels to draw on the server.'), { source });
  }
  return { open, source, heavy: decodedBytes(meta) > HEAVY_DECODE_BYTES };
}

/**
 * Draw `file`'s previews and put them in storage. `io` carries what touches
 * the outside, so the tests can play it:
 *   read(file, path)                 the original's bytes, to a file at `path`
 *   put(key, bytes, contentType)     a preview, into the base bucket
 *   sharp                            the module
 * Resolves { thumbnailKey, posterKey, sizes, placeholder, media } for
 * setFileThumbnail. Throws with a sentence for what went wrong.
 */
export async function drawServerPreviews(file, io) {
  const dir = await mkdtemp(join(io.tmp || tmpdir(), 'onyx-preview-'));
  try {
    const { open, source, heavy } = await openOriginal(file, io, dir);
    const sharp = io.sharp;
    const plan = previewPlan(source, { bytes: file.size, mime: file.mime });
    if (!plan) throw new Error('Nothing to draw for a picture this size.');

    // Decoded once, upright, to the largest size wanted; kept as raw pixels
    // (a 2400px picture is some 17 MB) for the rest to be cut from.
    const largest = plan.preview && plan.preview.width > plan.grid.width ? plan.preview : plan.grid;
    const { data, info } = await decodeInTurn(heavy, () => open()
      .rotate()
      .resize(largest.width, largest.height, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true }));
    const from = () => sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
    const webp = (size, quality) => {
      const img = size.width === info.width && size.height === info.height ? from() : from().resize(size.width, size.height, { fit: 'fill' });
      return img.webp({ quality: Math.round(quality * 100) }).toBuffer();
    };

    const id = randomUUID();
    const thumbnailKey = `_thumbs/${id}.webp`;
    await io.put(thumbnailKey, await webp(plan.grid, WEBP_QUALITY), 'image/webp');
    const sizes = [];
    for (const [name, dims] of Object.entries(plan.siblings)) {
      await io.put(thumbSiblingKey(thumbnailKey, name), await webp(dims, WEBP_QUALITY), 'image/webp');
      sizes.push(name);
    }
    let posterKey = null;
    if (plan.preview) {
      posterKey = `_thumbs/${id}.poster.webp`;
      await io.put(posterKey, await webp(plan.preview, PREVIEW_WEBP_QUALITY), 'image/webp');
    }
    let placeholder = null;
    if (plan.placeholder) {
      const tiny = await webp(plan.placeholder, PLACEHOLDER_QUALITY);
      placeholder = placeholderFacts(`data:image/webp;base64,${tiny.toString('base64')}`);
    }
    return { thumbnailKey, posterKey, sizes: sizes.length ? sizes : null, placeholder, media: source };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Draw only `file`'s large preview — for a picture whose thumbnail stands
 * (lib/db.js claimServerPosters) — and put it in storage: the WebP
 * drawServerPreviews would make, at the size lib/poster.js imagePreviewFor
 * gives it. Decoded upright straight to that size and encoded in the same
 * pass: nothing smaller is cut from it, so no raw copy is held. Resolves
 * { posterKey, media } for setServerPoster: posterKey null when the picture,
 * its size now read, needs no preview. Throws as drawServerPreviews does.
 */
export async function drawServerPoster(file, io) {
  const dir = await mkdtemp(join(io.tmp || tmpdir(), 'onyx-preview-'));
  try {
    const { open, source, heavy } = await openOriginal(file, io, dir);
    const preview = imagePreviewFor(source, { bytes: file.size, mime: imageMime(file) });
    if (!preview) return { posterKey: null, media: source };
    const bytes = await decodeInTurn(heavy, () => open()
      .rotate()
      .resize(preview.width, preview.height, { fit: 'fill' })
      .webp({ quality: Math.round(PREVIEW_WEBP_QUALITY * 100) })
      .toBuffer());
    const posterKey = `_thumbs/${randomUUID()}.poster.webp`;
    await io.put(posterKey, bytes, 'image/webp');
    return { posterKey, media: source };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * A placeholder for a file that has a thumbnail but none: cut from the
 * thumbnail's smallest copy (xs, then sm, then the grid one), which `io.readKey`
 * fetches from the base bucket to `path`. Resolves the data URL, or null.
 */
export async function drawPlaceholder(file, io) {
  const sizes = Array.isArray(file.thumbSizes) ? file.thumbSizes : String(file.thumbSizes || '').split(',');
  const key = (sizes.includes('xs') && thumbSiblingKey(file.thumbnailKey, 'xs'))
    || (sizes.includes('sm') && thumbSiblingKey(file.thumbnailKey, 'sm'))
    || file.thumbnailKey;
  const dir = await mkdtemp(join(io.tmp || tmpdir(), 'onyx-placeholder-'));
  try {
    const path = join(dir, 'thumb');
    await io.readKey(key, path);
    const img = io.sharp(path, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'none' });
    const meta = await img.metadata();
    const size = placeholderSize({ width: meta.width, height: meta.height });
    if (!size) return null;
    const tiny = await io.sharp(path).resize(size.width, size.height, { fit: 'fill' })
      .webp({ quality: Math.round(PLACEHOLDER_QUALITY * 100) }).toBuffer();
    return placeholderFacts(`data:image/webp;base64,${tiny.toString('base64')}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The real `io`: the original from its bucket (a drive's own, if it has one), previews into the base bucket. */
export async function storageIO() {
  const [{ getStorageConfig, storageForKey, s3ClientFor }, { default: sharp }] = await Promise.all([
    import('./storage.js'), import('sharp'),
  ]);
  const base = await getStorageConfig();
  return {
    sharp,
    async read(file, path) {
      const cfg = await storageForKey(base, file.storageKey);
      const { mod, client } = await s3ClientFor(cfg);
      const r = await client.send(new mod.GetObjectCommand({ Bucket: cfg.bucket, Key: file.storageKey }));
      await pipeline(r.Body, createWriteStream(path));
    },
    async readKey(key, path) {
      const { mod, client } = await s3ClientFor(base);
      const r = await client.send(new mod.GetObjectCommand({ Bucket: base.bucket, Key: key }));
      await pipeline(r.Body, createWriteStream(path));
    },
    async put(key, bytes, contentType) {
      const { mod, client } = await s3ClientFor(base);
      await client.send(new mod.PutObjectCommand({
        Bucket: base.bucket, Key: key, Body: bytes, ContentType: contentType, CacheControl: PREVIEW_CACHE_CONTROL,
      }));
    },
    async remove(key) {
      const { mod, client } = await s3ClientFor(base);
      await client.send(new mod.DeleteObjectCommand({ Bucket: base.bucket, Key: key })).catch(() => {});
    },
  };
}

// The originals this process has on disk, in bytes: each counted from its
// claim until its draw is done. Claims take turns (claimOriginal), so each
// asks only for what the others leave room for.
let onDisk = 0;
let claiming = Promise.resolve();

/**
 * `claim(room)` once no other claim of an original in this process is under
 * way, `room` being the bytes the originals on disk leave of
 * SERVER_PREVIEW_MAX_BYTES; what it hands back is counted until the worker
 * that draws it is done.
 */
function claimOriginal(claim) {
  const turn = claiming.then(async () => {
    const files = (await claim(Math.max(0, SERVER_PREVIEW_MAX_BYTES - onDisk))) || [];
    for (const f of files) onDisk += Number(f.size) || 0;
    return files;
  });
  claiming = turn.catch(() => {});
  return turn;
}

/** Remove what runs killed at maxDuration left in `dir` (STALE_TMP_MS). */
export async function clearStaleTmp(dir = tmpdir(), now = Date.now()) {
  for (const name of await readdir(dir).catch(() => [])) {
    if (!/^onyx-(preview|placeholder)-/.test(name)) continue;
    const path = join(dir, name);
    const at = (await stat(path).catch(() => null))?.mtimeMs;
    if (at && now - at > STALE_TMP_MS) await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * One cron run: claim, draw and record until `budgetMs` is spent, `concurrency`
 * at a time — images with no thumbnail first, then placeholders for
 * thumbnails without one, then the large previews pictures lack. A file
 * another hand gave a thumbnail, or a large preview, meanwhile keeps that
 * one, and ours are removed. Resolves { drawn, posters, kept, failed,
 * placeholders, errors }.
 */
export async function runServerPreviews({ budgetMs = 240_000, concurrency = 2, io = null, db = null } = {}) {
  const store = db || (await import('./db.js'));
  const out = { drawn: 0, posters: 0, kept: 0, failed: 0, placeholders: 0, errors: [] };
  const began = Date.now();
  let ioReady = io;
  await clearStaleTmp(io?.tmp || tmpdir());
  const failed = async (file, e, fallback) => {
    out.failed += 1;
    if (out.errors.length < 10) out.errors.push(`${file.name}: ${e.message}`);
    await store.setServerPreviewError(file.id, e.message || fallback).catch(() => {});
  };
  // Every preview, recorded with setFileThumbnail.
  const drawWhole = async (file) => {
    ioReady ||= await storageIO();
    try {
      const made = await drawServerPreviews(file, ioReady);
      if (await store.fileThumbnailKey(file.id)) {
        // A browser or a Mac got there first: theirs stays.
        for (const key of [made.thumbnailKey, made.posterKey, ...(made.sizes || []).map((s) => thumbSiblingKey(made.thumbnailKey, s))]) {
          if (key) await ioReady.remove?.(key);
        }
        out.kept += 1;
        return;
      }
      await store.setFileThumbnail(file.id, made.thumbnailKey, made.media, made.posterKey, made.sizes, { placeholder: made.placeholder });
      await store.setServerPreviewDrawn(file.id);
      out.drawn += 1;
    } catch (e) {
      await failed(file, e, 'Could not draw it.');
    }
  };
  // The large preview alone, recorded only while the row is as claimed and
  // still has none (setServerPoster).
  const drawPoster = async (file) => {
    ioReady ||= await storageIO();
    let put = null; // in the bucket, and no row holds it yet
    try {
      const made = await drawServerPoster(file, ioReady);
      put = made.posterKey;
      const took = await store.setServerPoster(file.id, made.posterKey, made.media, { thumbnailKey: file.thumbnailKey });
      if (took && put) {
        put = null;
        out.posters += 1;
        await store.setServerPreviewDrawn(file.id);
        return;
      }
      if (put) {
        // A browser or a Mac recorded one first, or the picture changed: ours goes.
        await ioReady.remove?.(put);
        put = null;
        out.kept += 1;
      }
      await store.setServerPreviewError(file.id, null);
    } catch (e) {
      // Put, and the database failed around recording it: removed once no
      // row is found to hold it (unreferencedPreviewKeys answers only when it
      // is sure), so a write that went through, its answer lost, keeps it.
      if (put) {
        for (const key of await store.unreferencedPreviewKeys({ posterKeys: [put] })) {
          await Promise.resolve(ioReady.remove?.(key)).catch(() => {});
        }
      }
      // Too many pixels, its size now read: recorded, the next claim leaves
      // it out rather than read the whole original again to find the same.
      if (e.source) await store.setServerPoster(file.id, null, e.source, { thumbnailKey: file.thumbnailKey }).catch(() => {});
      await failed(file, e, 'Could not draw its preview.');
    }
  };
  // A few placeholders, each cut from a thumbnail's smallest copy.
  const drawPlaceholders = async (few) => {
    ioReady ||= await storageIO();
    for (const f of few) {
      try {
        const placeholder = await drawPlaceholder(f, ioReady);
        if (!placeholder) continue;
        // Recorded only for the thumbnail it was cut from (setFilePlaceholder).
        const row = await store.setFilePlaceholder(f.id, placeholder, { thumbnailKey: f.thumbnailKey });
        if (row !== 'changed') out.placeholders += 1;
        if (row && row !== 'changed') await store.setServerPreviewDrawn(f.id);
      } catch (e) {
        out.failed += 1;
        await store.setServerPreviewError(f.id, e.message || 'Could not draw a placeholder.').catch(() => {});
      }
    }
  };
  const worker = async () => {
    while (Date.now() - began < budgetMs) {
      let [file] = await claimOriginal((room) => store.claimServerPreviews({ limit: 1, maxBytes: room }));
      let draw = drawWhole;
      if (!file) {
        // Nothing left to draw whole: placeholders for thumbnails without
        // one, a few at a time — each is a few kilobytes.
        const few = await store.claimServerPlaceholders?.({ limit: 4 }) || [];
        if (few.length) {
          await drawPlaceholders(few);
          continue;
        }
        // Then the large previews pictures lack, one at a time: each is
        // its original read whole, as a thumbnail is.
        [file] = await claimOriginal((room) => store.claimServerPosters?.({
          limit: 1, maxBytes: room, maxPixels: MAX_INPUT_PIXELS,
        }));
        if (!file) return;
        draw = drawPoster;
      }
      try {
        await draw(file);
      } finally {
        onDisk -= Number(file.size) || 0;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}
