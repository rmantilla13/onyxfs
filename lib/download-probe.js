// lib/download-probe.js — what this browser can make, for the Download-as
// choices (lib/download-formats.js downloadChoices).
//
// Every canvas encodes JPEG and PNG. WebP and AVIF are asked of this one: a
// canvas asked for a type it cannot write hands back a PNG without saying so,
// so each is tried once, on a canvas two pixels wide, and offered only when
// what came back is what was asked for. Separate from lib/download-client.js
// so the dialog can ask this without loading the converter.

import { MAX_CANVAS_PIXELS, MOBILE_MAX_CANVAS_PIXELS } from './download-formats.js';

let asked = null;
let settled = null;

function encodes(canvas, type) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(!!b && b.type === type), type, 0.9);
    } catch {
      resolve(false);
    }
  });
}

/** { webp, avif }: which of the two this browser's canvas encodes. Tried once per page load. */
export function probeEncoders() {
  asked ||= (async () => {
    if (typeof document === 'undefined') return { webp: false, avif: false };
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    canvas.getContext('2d')?.fillRect(0, 0, 1, 1);
    const [webp, avif] = await Promise.all([encodes(canvas, 'image/webp'), encodes(canvas, 'image/avif')]);
    settled = { webp, avif };
    return settled;
  })();
  return asked;
}

/** The answer, once the probe has settled; null before. */
export function encodersNow() {
  return settled;
}

/**
 * Whether this browser has WebCodecs' video encoder and decoder — whether a
 * video's copies could be made here at all. What this file needs of them is
 * asked when its dialog opens (lib/video-client.js).
 */
export function videoCodecsNow() {
  return typeof VideoEncoder === 'function' && typeof VideoDecoder === 'function';
}

/**
 * Whether this browser can write a video's copy straight to a file the
 * person picks, as it is made (the File System Access API: Chrome, Edge) —
 * the only way a copy too large to hold in memory can be made.
 */
export function canSaveToDisk() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function' && window.isSecureContext !== false;
}

/**
 * The most pixels a canvas holds here. iOS and iPadOS Safari refuse one past
 * 4096² — an iPad asking for the desktop site says it is a Mac, and gives
 * itself away by its touch points; the Mac app's web view has none.
 */
export function maxCanvasPixels() {
  if (typeof navigator === 'undefined') return MAX_CANVAS_PIXELS;
  const ua = navigator.userAgent || '';
  const ios = /\biP(hone|ad|od)\b/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return ios ? MOBILE_MAX_CANVAS_PIXELS : MAX_CANVAS_PIXELS;
}
