// lib/thumbnail-render.js — an image's previews, drawn in a worker.
//
// What draw() in lib/thumbnail-client.js makes of an image — its large
// preview, the grid thumbnail, the sm and xs siblings and the placeholder —
// at the same sizes (lib/poster.js, lib/placeholder.js), in the same formats
// at the same qualities, made in the worker lib/thumbnail-offthread.js runs,
// so the page never stalls on it. The page decodes the whole picture in an
// <img> and draws it down through canvases to the largest preview; here its
// size comes from the header (lib/image-header.js) and createImageBitmap
// decodes straight to the largest rendition, so a 24-megapixel photo is
// never held at full size where the browser can scale it while decoding.
// Chrome, measured, cannot: it decodes the whole picture and resamples it,
// a tenth or so slower than the page's canvases would draw it down — but
// not on the page's thread. Every smaller rendition is drawn from the one
// before, halving at most per step, as on the page.
//
// What a browser might lack is probed once, in the worker (workerCaps). A
// picture this cannot make exactly as the page would — a header it does not
// read, a decode that fails or comes back another size — throws, and the page
// draws it itself.
//
// Its surroundings (createImageBitmap, OffscreenCanvas) are passed in, so the
// tests run it with stand-ins against the page's own drawing.

import {
  gridPosterSize, imagePreviewFor, thumbSiblingSizes, downscalePlan,
  WEBP_QUALITY, JPEG_QUALITY, PREVIEW_WEBP_QUALITY, PREVIEW_JPEG_QUALITY,
} from './poster.js';
import { placeholderSize, placeholderFacts, compactPlaceholder, PLACEHOLDER_QUALITY } from './placeholder.js';
import { imageHeaderSize } from './image-header.js';

/** The worker's own createImageBitmap and OffscreenCanvas. */
function here() {
  return { createImageBitmap: (...args) => globalThis.createImageBitmap(...args), OffscreenCanvas: globalThis.OffscreenCanvas };
}

/**
 * The sizes draw() makes of an image `source` in size, orientation applied:
 * `large` its preview (null when the original serves — imagePreviewFor),
 * `grid` the thumbnail, `sm` and `xs` the siblings worth making, and `tiny`
 * the one its placeholder is drawn from, the smallest. `decode` is the
 * largest of them, what the picture is decoded to. Null without a size.
 */
export function imagePlan(source, { bytes, mime } = {}) {
  const grid = gridPosterSize(source);
  if (!grid) return null;
  const large = imagePreviewFor(source, { bytes, mime });
  const { sm = null, xs = null } = thumbSiblingSizes(source);
  return { decode: large || grid, large, grid, sm, xs, tiny: xs || sm || grid };
}

/** draw()'s drawDown: `el` of `from` size down to `to`, halving at most per step. The last canvas. */
function drawDown(env, el, from, to) {
  let src = el;
  let canvas = null;
  for (const step of downscalePlan(from, to)) {
    canvas = new env.OffscreenCanvas(step.width, step.height);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, step.width, step.height);
    // An intermediate is dropped as soon as the next step has read it.
    if (src !== el && src instanceof env.OffscreenCanvas) { src.width = 0; src.height = 0; }
    src = canvas;
  }
  return canvas;
}

async function encode(canvas, { webp = WEBP_QUALITY, jpeg = JPEG_QUALITY } = {}) {
  // No WebP encoder hands back a PNG instead, as on the page: JPEG then.
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: webp });
  return blob.type === 'image/webp' ? blob : canvas.convertToBlob({ type: 'image/jpeg', quality: jpeg });
}

/** Encode as exactly `type`, or null — a sibling shares its thumbnail's format. */
async function encodeAs(canvas, type) {
  const blob = await canvas.convertToBlob({ type, quality: type === 'image/webp' ? WEBP_QUALITY : JPEG_QUALITY }).catch(() => null);
  return blob && blob.type === type ? blob : null;
}

async function dataUrl(blob) {
  const b = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return `data:${blob.type};base64,${btoa(s)}`;
}

/** draw()'s placeholderOf: `canvas`, of `from` size, as its placeholder data URL, or null. */
async function placeholderOf(env, canvas, from) {
  const to = placeholderSize(from);
  if (!canvas || !to) return null;
  const tiny = to.width < from.width || to.height < from.height ? drawDown(env, canvas, from, to) : canvas;
  try {
    let pic = await tiny.convertToBlob({ type: 'image/webp', quality: PLACEHOLDER_QUALITY });
    if (pic.type !== 'image/webp') pic = await tiny.convertToBlob({ type: 'image/jpeg', quality: PLACEHOLDER_QUALITY });
    return placeholderFacts(compactPlaceholder(await dataUrl(pic)));
  } catch {
    return null;
  } finally {
    if (tiny !== canvas) { tiny.width = 0; tiny.height = 0; }
  }
}

const blobRange = (blob) => async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer());

/**
 * Every rendition draw() makes of the image in `blob`, and its size:
 * { blob, poster?, siblings: { sm?, xs? }, placeholder?, media: { width, height } }.
 * `facts` are what draw() reads off the file: its `bytes` and `mime`, which
 * decide the preview, and whether it may be `transparent`, which drops a JPEG
 * preview. Throws when this cannot make them as the page would.
 */
export async function renderImage(blob, { bytes, mime, transparent = false } = {}, env = here()) {
  const source = await imageHeaderSize(blobRange(blob), { size: blob.size });
  if (!source) throw new Error('Not a header this reads: the page draws it.');
  const plan = imagePlan(source, { bytes, mime });
  if (!plan) throw new Error('The file has no dimensions.');
  const { decode } = plan;
  const whole = decode.width === source.width && decode.height === source.height;
  const bitmap = await env.createImageBitmap(blob, whole
    ? { imageOrientation: 'from-image' }
    : { resizeWidth: decode.width, resizeHeight: decode.height, resizeQuality: 'high', imageOrientation: 'from-image' });
  let top;
  try {
    // Another size than asked for: this browser reads the file otherwise
    // than its header says, and the page's reading is the one that counts.
    if (bitmap.width !== decode.width || bitmap.height !== decode.height) throw new Error('Decoded to another size.');
    top = drawDown(env, bitmap, decode, decode);
  } finally {
    bitmap.close?.();
  }

  // From here, draw() step for step.
  const big = plan.large ? top : null;
  const grid = plan.large ? drawDown(env, top, plan.large, plan.grid) : top;
  const sm = plan.sm ? drawDown(env, grid, plan.grid, plan.sm) : null;
  const xs = plan.xs ? (sm ? drawDown(env, sm, plan.sm, plan.xs) : drawDown(env, grid, plan.grid, plan.xs)) : null;
  const placeholder = await placeholderOf(env, xs || sm || grid, plan.tiny);

  const thumb = await encode(grid);
  const siblings = {};
  if (sm) { const b = await encodeAs(sm, thumb.type); if (b) siblings.sm = b; }
  if (xs) { const b = await encodeAs(xs, thumb.type); if (b) siblings.xs = b; }

  let poster = null;
  if (big) {
    poster = await encode(big, { webp: PREVIEW_WEBP_QUALITY, jpeg: PREVIEW_JPEG_QUALITY });
    // A JPEG preview of a picture that may have transparency would put it on
    // black: the original serves instead.
    if (poster.type === 'image/jpeg' && transparent) poster = null;
    big.width = 0;
    big.height = 0;
  }
  return {
    blob: thumb, ...(poster ? { poster } : {}), siblings, ...(placeholder ? { placeholder } : {}),
    media: { width: source.width, height: source.height },
  };
}

// 16x8, red on the left and blue on the right, with EXIF orientation 6: shown
// upright it is 8x16, red above blue.
const PROBE_JPEG = '/9j/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAIABADAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAABwj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAACQf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdEMKmAjjB0f/Z';

/**
 * What this worker can do of what renderImage needs: an OffscreenCanvas with
 * a 2D context that encodes (`encode`, JPEG; `webp` too, or not), and a
 * createImageBitmap that decodes a JPEG straight to another size, and knows
 * to do it well (`resize`), turned upright by its EXIF first (`orientation`)
 * — checked on the probe picture's pixels, not taken on trust. Anything
 * missing is false.
 */
export async function workerCaps(env = here()) {
  const caps = { offscreen: false, encode: false, webp: false, resize: false, orientation: false };
  try {
    const canvas = new env.OffscreenCanvas(8, 8);
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof canvas.convertToBlob !== 'function' || typeof env.createImageBitmap !== 'function') return caps;
    caps.offscreen = true;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 8, 8);
    caps.webp = (await canvas.convertToBlob({ type: 'image/webp', quality: WEBP_QUALITY })).type === 'image/webp';
    caps.encode = (await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })).type === 'image/jpeg';
    const bytes = Uint8Array.from(atob(PROBE_JPEG), (c) => c.charCodeAt(0));
    // A browser reads every option it knows as it takes them. One that never
    // asks for resizeQuality would shrink a picture 5x in one cheap step,
    // which aliases: the page's halving is better than that.
    let quality = false;
    const bitmap = await env.createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), {
      resizeWidth: 4, resizeHeight: 8, imageOrientation: 'from-image', get resizeQuality() { quality = true; return 'high'; },
    });
    try {
      caps.resize = bitmap.width === 4 && bitmap.height === 8 && quality;
      if (caps.resize) {
        const look = new env.OffscreenCanvas(4, 8).getContext('2d', { willReadFrequently: true });
        look.drawImage(bitmap, 0, 0);
        const [r1, , b1] = look.getImageData(2, 1, 1, 1).data;
        const [r2, , b2] = look.getImageData(2, 6, 1, 1).data;
        caps.orientation = r1 > b1 + 96 && b2 > r2 + 96;
      }
    } finally {
      bitmap.close?.();
    }
  } catch {
    // Whatever was not shown to work is taken to be missing.
  }
  return caps;
}
