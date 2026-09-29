// lib/image-convert.js — decode a picture, turn it the right way up, scale it
// with care, encode it: the one pipeline behind every "Download as…" copy.
//
// Written against a small environment rather than the DOM, so the same code
// runs in the worker (lib/image-convert.worker.js: OffscreenCanvas, the page
// never waits on it) and, where a browser has no worker canvas or its worker
// cannot decode the format, on the page (lib/download-client.js). `env`:
//
//   decode(blob)          → something drawImage takes, with width and height
//   canvas(width, height) → a canvas of that size
//   encode(canvas, type, quality) → a Blob
//
// Scaling goes down by halves at most (lib/poster.js downscalePlan): a single
// draw that shrinks by more than 2x samples too few pixels and aliases.

import { downscalePlan } from './poster.js';
import { exifOrientation, orientedSize, orientationTransform, swapsAxes } from './exif-orientation.js';
import { targetSize, MAX_CANVAS_PIXELS } from './download-formats.js';

/** Why a conversion stopped: `code` is 'decode', 'encode', 'pixels' or 'unsupported'. */
export class ConvertError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConvertError';
    this.code = code;
  }
}

// 16 × 8 pixels stored, EXIF orientation 6: shown 8 × 16. A decoder that
// applies orientation hands it back taller than it is wide.
const ORIENTATION_PROBE = '/9j/4QAiRXhpZgAASUkqAAgAAAABABIBAwABAAAABgAAAAAAAAD/2wBDABQODxIPDRQSEBIXFRQYHjIhHhwcHj0sLiQySUBMS0dARkVQWnNiUFVtVkVGZIhlbXd7gYKBTmCNl4x9lnN+gXz/2wBDARUXFx4aHjshITt8U0ZTfHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHz/wAARCAAIABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABf/EABkRAAIDAQAAAAAAAAAAAAAAAAAFQoHBQ//aAAwDAQACEQMRAD8AlJgEEnStFG8Lw//Z';

/** The probe picture, as a JPEG Blob. */
export function orientationProbe() {
  const bin = atob(ORIENTATION_PROBE);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/jpeg' });
}

// Per decoder, once: a worker and the page may answer differently.
const applied = new WeakMap();

/** Whether `decode` turns a picture by its EXIF orientation itself. A probe that fails says yes: every current engine does. */
export function decoderAppliesOrientation(decode) {
  if (!applied.has(decode)) {
    applied.set(decode, (async () => {
      try {
        const pic = await decode(orientationProbe());
        const yes = pic.height > pic.width;
        pic.close?.();
        return yes;
      } catch {
        return true;
      }
    })());
  }
  return applied.get(decode);
}

/**
 * createImageBitmap with EXIF orientation applied, where this browser knows
 * the option. One that does not throws a TypeError for the value, and is
 * asked again without it — whether it then applied orientation anyway is
 * decoderAppliesOrientation's to find out.
 */
export async function decodeBitmap(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (e) {
    if (e?.name !== 'TypeError') throw e;
  }
  return createImageBitmap(blob);
}

function release(canvas) {
  // A canvas is held until collected; a zero-sized one gives its pixels back now.
  try { canvas.width = 0; canvas.height = 0; } catch { /* a detached OffscreenCanvas */ }
}

/**
 * Draw `source` (`size` its stored width × height), turned by `orientation`
 * when `turn` is set, at `longEdge` (null: full size), and encode it as
 * `format` (an IMAGE_FORMATS entry). Resolves { blob, width, height, source }.
 */
export async function renderPicture(source, size, { orientation = 1, turn = false, format, longEdge = null, maxPixels = MAX_CANVAS_PIXELS, env }) {
  const shown = turn ? orientedSize(size, orientation) : { width: size.width, height: size.height };
  const target = targetSize(shown, longEdge);
  if (!target) throw new ConvertError('decode', 'The picture has no size this browser could read.');
  if (target.width * target.height > maxPixels) {
    throw new ConvertError('pixels', 'This picture is too large to convert at full size in this browser. Choose a smaller size.');
  }
  const plan = downscalePlan(shown, target);
  let from = source;
  let canvas = null;
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    const last = i === plan.length - 1;
    canvas = env.canvas(step.width, step.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new ConvertError('unsupported', 'This browser has no canvas to draw on.');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // A format with no transparency is laid on white, not the black a
    // canvas's clear pixels encode as.
    if (last && !format.alpha) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, step.width, step.height);
    }
    if (i === 0 && turn && orientation !== 1) {
      // Drawn in the stored orientation, scaled to this step, and turned.
      const w = swapsAxes(orientation) ? step.height : step.width;
      const h = swapsAxes(orientation) ? step.width : step.height;
      ctx.setTransform(...orientationTransform(orientation, w, h));
      ctx.drawImage(from, 0, 0, w, h);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    } else {
      ctx.drawImage(from, 0, 0, step.width, step.height);
    }
    if (from !== source) release(from);
    from = canvas;
  }
  let blob;
  try {
    blob = await env.encode(canvas, format.mime, format.quality ?? undefined);
  } catch {
    blob = null;
  }
  release(canvas);
  // Asked for a type it cannot write, a canvas writes a PNG instead.
  if (!blob || blob.type !== format.mime) throw new ConvertError('encode', `This browser cannot save ${format.label} pictures.`);
  // The picture's own size too, as shown: what the copy's name compares
  // against ("Name (1920 px).jpg" only when it came out smaller).
  return { blob, width: target.width, height: target.height, source: shown };
}

/**
 * A picture file (a Blob) converted: its orientation read from its first
 * bytes, decoded, turned if the decoder did not, scaled and encoded.
 * Resolves { blob, width, height, source }.
 */
export async function convertBlob(file, { format, longEdge = null, maxPixels = MAX_CANVAS_PIXELS, env }) {
  const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  const orientation = exifOrientation(head);
  let pic;
  try {
    pic = await env.decode(file);
  } catch {
    throw new ConvertError('decode', 'This browser cannot open this picture.');
  }
  try {
    const turn = orientation !== 1 && !(await decoderAppliesOrientation(env.decode));
    return await renderPicture(pic, { width: pic.width, height: pic.height }, { orientation, turn, format, longEdge, maxPixels, env });
  } finally {
    pic.close?.();
  }
}
