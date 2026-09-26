// lib/filmstrip-client.js — the hover-scrub sprite sheet, made in the browser.
//
// The browser is already decoding the video at upload to draw a poster (see
// thumbnail-client.js), so it seeks through the same local file and tiles 40
// frames into one WebP. That sheet is what the player shows under the pointer
// while scrubbing: one small cached request, instead of a range request into a
// multi-gigabyte master for every pixel of pointer travel.
//
// ONLY at upload, from a local File. A backfill over a presigned URL would
// mean forty range requests into the original per video, which is exactly the
// egress this exists to avoid — so an older row simply has no strip, and the
// player falls back to a timecode tooltip.

import { putToBucket } from './multipart-client';
import { drawableKind } from './media';
import { filmstripLayout, filmstripTimes, FILMSTRIP_DENSITY, FILMSTRIP_MAX_SHEET } from './filmstrip';
import { downscalePlan } from './poster';

// The whole sheet, not per frame. A long clip on a slow machine can seek
// slowly, and a half-built strip is worth abandoning rather than blocking the
// upload behind it.
const TIMEOUT_MS = 45000;
// Under this there is nothing to scrub through, and 40 tiles of a 3-second clip
// is 40 near-identical frames.
const MIN_DURATION_S = 5;
// The longest a seek waits for a frame signal before drawing anyway (seekTo).
const FRAME_WAIT_MS = 250;
// WebP quality for the sheet, as it always was. At 2x a 1080p or 4K clip's
// sheet is 2560x900 and ~165KB, against ~70KB for the 1x one; it is fetched
// once, on the first hover, and cached for good.
const STRIP_WEBP_QUALITY = 0.7;

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out building the filmstrip.')), ms));
}

/** Seek and wait for the frame to actually be presentable. */
function seekTo(video, time) {
  return new Promise((resolve, reject) => {
    // `seeked` fires when the seek completes, but the frame is not necessarily
    // decoded yet — drawing then can paint the PREVIOUS frame. Where
    // requestVideoFrameCallback exists it tells us a new frame is ready, which
    // is the only reliable signal; elsewhere `seeked` plus a paint is the best
    // available and is what the poster path already relies on.
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    video.onseeked = () => {
      if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(() => done());
      else requestAnimationFrame(() => done());
      // Neither fires in a hidden tab — an upload left running behind another
      // one — so without a bound the first seek never finished, the strip hit
      // TIMEOUT_MS, and the upload's registration, which awaits the strip,
      // waited 45 seconds for nothing. By `seeked` Chrome has the frame.
      setTimeout(done, FRAME_WAIT_MS);
    };
    video.onerror = () => reject(new Error('The video errored while seeking.'));
    try { video.currentTime = time; } catch (e) { reject(e); }
  });
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(
    (b) => (b ? resolve(b) : reject(new Error('Could not encode the filmstrip.'))), type, quality
  ));
}

/**
 * A function that draws a `from`-sized frame into a `to`-sized box of the
 * sheet. A 1080p frame into a 320px tile is a 6x reduction, and one draw that
 * shrinks by more than 2x aliases (lib/poster.js, downscalePlan) — so it goes
 * through halving steps, on scratch canvases made once and reused for all
 * forty frames.
 */
function tileDrawer(from, to) {
  const scratch = downscalePlan(from, to).slice(0, -1).map((step) => {
    const c = document.createElement('canvas');
    c.width = step.width;
    c.height = step.height;
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = true;
    // Each step at most halves, where bilinear is already a clean average.
    x.imageSmoothingQuality = 'medium';
    return { c, x, ...step };
  });
  return (el, ctx, dx, dy) => {
    let src = el;
    for (const s of scratch) {
      s.x.clearRect(0, 0, s.width, s.height);
      s.x.drawImage(src, 0, 0, s.width, s.height);
      src = s.c;
    }
    ctx.drawImage(src, dx, dy, to.width, to.height);
  };
}

/**
 * Build a sprite sheet from a local video File.
 *
 * Resolves { blob, filmstrip: { frames, columns, tileWidth, tileHeight } }, or
 * null when there is nothing worth building — not a video this browser decodes,
 * too short, or no duration to spread frames across.
 */
export async function makeFilmstrip(source, file) {
  if (drawableKind(file) !== 'video') return null;
  if (typeof source === 'string') return null;   // upload only; see the header

  const cleanup = [];
  try {
    const work = (async () => {
      const url = URL.createObjectURL(source);
      cleanup.push(() => URL.revokeObjectURL(url));

      const video = document.createElement('video');
      cleanup.push(() => { video.removeAttribute('src'); video.load(); });
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';

      await new Promise((resolve, reject) => {
        video.onloadedmetadata = () => (video.videoWidth ? resolve() : reject(new Error('No decodable video track.')));
        video.onerror = () => reject(new Error('This browser cannot decode the video.'));
        video.src = url;
      });

      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      if (duration < MIN_DURATION_S) return null;

      const frame = { width: video.videoWidth, height: video.videoHeight };
      const layout = filmstripLayout({ ...frame, density: FILMSTRIP_DENSITY });
      // A clip so tall that even a 1x sheet passes the limit would be refused
      // by the server (filmstripFacts) after it had been built and uploaded.
      if (!layout || Math.max(layout.pixelWidth, layout.pixelHeight) > FILMSTRIP_MAX_SHEET) return null;
      // Tiles are drawn at `density` image pixels per CSS pixel; the geometry
      // recorded below stays in CSS pixels (lib/filmstrip.js).
      const d = layout.density;
      const tile = { width: layout.tileWidth * d, height: layout.tileHeight * d };

      const canvas = document.createElement('canvas');
      canvas.width = layout.pixelWidth;
      canvas.height = layout.pixelHeight;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      const drawTile = tileDrawer(frame, tile);

      const times = filmstripTimes(duration, layout.frames);
      let drawn = 0;
      for (let i = 0; i < times.length; i++) {
        try { await seekTo(video, times[i]); } catch { break; }
        const col = i % layout.columns;
        const row = Math.floor(i / layout.columns);
        drawTile(video, ctx, col * tile.width, row * tile.height);
        drawn += 1;
      }
      // A strip that covers only the opening of a clip is worse than none: the
      // pointer would show the same early frame across most of the bar and read
      // as broken rather than absent.
      if (drawn < layout.frames * 0.75) return null;

      const blob = await toBlob(canvas, 'image/webp', STRIP_WEBP_QUALITY);
      // A browser with no WebP encoder hands back a PNG — a 40-tile PNG is
      // megabytes, so it is not worth uploading.
      if (blob.type !== 'image/webp') return null;

      return {
        blob,
        filmstrip: {
          frames: layout.frames, columns: layout.columns,
          tileWidth: layout.tileWidth, tileHeight: layout.tileHeight,
        },
      };
    })();
    work.catch(() => {});   // lost the race; its failure is not news
    return await Promise.race([work, timeout(TIMEOUT_MS)]);
  } finally {
    for (const fn of cleanup) fn();
  }
}

/** Put a sheet in the bucket under a key the server names. Resolves the key. */
export async function uploadFilmstrip(blob) {
  const res = await fetch('/api/files/presign', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ strip: true, contentType: blob.type }),
  });
  const pre = await res.json().catch(() => ({}));
  if (!res.ok || pre.error) throw new Error(pre.error || `Could not start the filmstrip upload (HTTP ${res.status}).`);
  await putToBucket(pre.putUrl, blob, {
    contentType: blob.type,
    headers: pre.cacheControl ? { 'cache-control': pre.cacheControl } : undefined,
  });
  return pre.key;
}

/**
 * The filmstrip for a file being uploaded: { key, filmstrip }, or null.
 *
 * Never rejects. A clip without a hover preview is still a clip and must still
 * upload — this is an enhancement, and it is never allowed to fail an upload.
 */
export async function filmstripForUpload(file) {
  try {
    const strip = await makeFilmstrip(file, { name: file.name, mime: file.type, size: file.size });
    if (!strip) return null;
    return { key: await uploadFilmstrip(strip.blob), filmstrip: strip.filmstrip };
  } catch {
    return null;
  }
}
