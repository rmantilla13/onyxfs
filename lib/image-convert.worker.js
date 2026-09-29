// lib/image-convert.worker.js — "Download as…" conversions, off the page's
// thread. Started per job by lib/download-client.js and terminated when the
// job ends or is cancelled, so a cancelled conversion stops at once and holds
// no memory after.
//
// In:  { blob, format, longEdge, maxPixels }             a picture file
//      { bitmap, width, height, format, maxPixels }      a video frame, drawn already
// Out: { ok: true, blob, width, height }
//      { ok: false, code, message }   code 'unsupported' (no worker canvas here),
//                                     'decode', 'encode' or 'pixels' — the page
//                                     tries again itself for all but 'pixels'.

import { convertBlob, renderPicture, decodeBitmap, ConvertError } from './image-convert.js';

const env = {
  decode: decodeBitmap,
  canvas: (width, height) => new OffscreenCanvas(width, height),
  encode: (canvas, type, quality) => canvas.convertToBlob(quality == null ? { type } : { type, quality }),
};

function supported() {
  return typeof OffscreenCanvas === 'function'
    && typeof OffscreenCanvas.prototype.convertToBlob === 'function'
    && typeof createImageBitmap === 'function';
}

self.onmessage = async ({ data }) => {
  try {
    if (!supported()) throw new ConvertError('unsupported', 'No canvas in a worker here.');
    const { format, longEdge = null, maxPixels } = data;
    const out = data.bitmap
      ? await renderPicture(data.bitmap, { width: data.width, height: data.height }, { format, longEdge, maxPixels, env })
      : await convertBlob(data.blob, { format, longEdge, maxPixels, env });
    data.bitmap?.close?.();
    self.postMessage({ ok: true, ...out });
  } catch (e) {
    self.postMessage({ ok: false, code: e?.code || 'decode', message: e?.message || 'The conversion failed.' });
  }
};
