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
// The original is read to a temporary file, never held in memory, and
// decoded once, upright, to the largest size wanted; each smaller one is
// made from that. sharp reads a JPEG at a fraction of its size when it can
// (shrink-on-load) and the rest in one pass (sequentialRead), so a picture of
// hundreds of megabytes costs about what its output does — up to a pixel
// limit (MAX_INPUT_PIXELS), past which it is the Mac's (ImageIO subsamples).

import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import {
  gridPosterSize, thumbSiblingSizes, imagePreviewFor, WEBP_QUALITY, PREVIEW_WEBP_QUALITY,
} from './poster.js';
import { placeholderSize, PLACEHOLDER_QUALITY, placeholderFacts } from './placeholder.js';
import { thumbSiblingKey, PREVIEW_CACHE_CONTROL } from './media.js';

// What one run may take on: Vercel's /tmp holds 512 MB, and the file goes
// there whole.
export const SERVER_PREVIEW_MAX_BYTES = 450 * 1024 * 1024;
// 16384 x 16384, as a browser's canvas (lib/download-formats.js
// MAX_CANVAS_PIXELS) and the Mac's ImageIO limit allow.
export const MAX_INPUT_PIXELS = 16384 * 16384;

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
  const original = join(dir, 'original');
  try {
    await io.read(file, original);
    const size = (await stat(original)).size;
    if (size > SERVER_PREVIEW_MAX_BYTES) throw new Error('Too big to draw on the server.');

    const sharp = io.sharp;
    const open = () => sharp(original, { limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true, failOn: 'none', pages: 1 });
    const meta = await open().metadata();
    const source = uprightSize(meta);
    if (!source) throw new Error('The picture has no size sharp can read.');
    if (source.width * source.height > MAX_INPUT_PIXELS) throw new Error('Too many pixels to draw on the server.');
    const plan = previewPlan(source, { bytes: file.size, mime: file.mime });
    if (!plan) throw new Error('Nothing to draw for a picture this size.');

    // Decoded once, upright, to the largest size wanted; kept as raw pixels
    // (a 2400px picture is some 17 MB) for the rest to be cut from.
    const largest = plan.preview && plan.preview.width > plan.grid.width ? plan.preview : plan.grid;
    const { data, info } = await open()
      .rotate()
      .resize(largest.width, largest.height, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
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

/**
 * One cron run: claim, draw and record until `budgetMs` is spent, `concurrency`
 * at a time. A file another hand gave a thumbnail meanwhile keeps that one,
 * and ours are removed. Resolves { drawn, kept, failed }.
 */
export async function runServerPreviews({ budgetMs = 240_000, concurrency = 2, io = null, db = null } = {}) {
  const store = db || (await import('./db.js'));
  const out = { drawn: 0, kept: 0, failed: 0, placeholders: 0, errors: [] };
  const began = Date.now();
  let ioReady = io;
  const worker = async () => {
    while (Date.now() - began < budgetMs) {
      const [file] = await store.claimServerPreviews({ limit: 1, maxBytes: SERVER_PREVIEW_MAX_BYTES });
      if (!file) {
        // Nothing left to draw whole: placeholders for thumbnails without
        // one, a few at a time — each is a few kilobytes.
        const few = await store.claimServerPlaceholders?.({ limit: 4 }) || [];
        if (!few.length) return;
        ioReady ||= await storageIO();
        for (const f of few) {
          try {
            const placeholder = await drawPlaceholder(f, ioReady);
            // Recorded only for the thumbnail it was cut from (setFilePlaceholder).
            if (placeholder && (await store.setFilePlaceholder(f.id, placeholder, { thumbnailKey: f.thumbnailKey })) !== 'changed') {
              out.placeholders += 1;
            }
          } catch (e) {
            out.failed += 1;
            await store.setServerPreviewError(f.id, e.message || 'Could not draw a placeholder.').catch(() => {});
          }
        }
        continue;
      }
      ioReady ||= await storageIO();
      let made = null;
      try {
        made = await drawServerPreviews(file, ioReady);
        if (await store.fileThumbnailKey(file.id)) {
          // A browser or a Mac got there first: theirs stays.
          for (const key of [made.thumbnailKey, made.posterKey, ...(made.sizes || []).map((s) => thumbSiblingKey(made.thumbnailKey, s))]) {
            if (key) await ioReady.remove?.(key);
          }
          out.kept += 1;
          continue;
        }
        await store.setFileThumbnail(file.id, made.thumbnailKey, made.media, made.posterKey, made.sizes, { placeholder: made.placeholder });
        await store.setServerPreviewError(file.id, null);
        out.drawn += 1;
      } catch (e) {
        out.failed += 1;
        if (out.errors.length < 10) out.errors.push(`${file.name}: ${e.message}`);
        await store.setServerPreviewError(file.id, e.message || 'Could not draw it.').catch(() => {});
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}
