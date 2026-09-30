// lib/image-header.js — a picture's size, read from the start of its file.
//
// The worker that draws an image's previews (lib/thumbnail-render.js) decodes
// it straight to the largest size it makes, so it needs the picture's size
// first. Decoding it once just to measure would cost what that saves; the
// header says it in a few hundred bytes.
//
// The size has to be the one an <img> reports, orientation applied — what the
// page records as the file's (lib/thumbnail-client.js) — or every preview is
// squeezed. So it is given only where browsers agree on it: a JPEG, turned by
// its EXIF orientation as every browser turns it, and a PNG or a WebP that
// carries no EXIF of its own. Where they do not agree it is null, and the
// picture is drawn on the page as it always was: a PNG's eXIf chunk (Chrome
// turns the picture by it, not every browser does), a WebP's EXIF (Chrome does
// not), an orientation said twice or in a form one reader takes and another
// ignores. So is every other format — GIF, AVIF, HEIC, TIFF, BMP.
//
// Import-free and isomorphic, like lib/capture-date.js: it reads through an
// injected `readRange(start, end) → Uint8Array` (end exclusive, like
// File.slice), so the tests hand it bytes.

// The first read. A JPEG's frame header is usually within the first few KB,
// behind its EXIF; whatever else sits ahead of it — a colour profile, XMP, a
// portrait photo's depth map in extended XMP, megabytes of it — is stepped
// over a segment header at a time.
const HEAD = 64 * 1024;
// How far into a file, and past how many segments or chunks, the header is
// looked for before the page is left to it.
const MAX_SCAN = 32 * 1024 * 1024;
const MAX_STEPS = 1024;

// JPEG frame headers: every SOFn but DHT (C4), JPG (C8) and DAC (CC).
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const EXIF_ID = 'Exif\0\0';
const XMP_ID = 'http://ns.adobe.com/xap/1.0/\0';
const TAG_ORIENTATION = 0x0112;
const SHORT = 3;

const text = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
const be16 = (b, o) => (b[o] << 8) | b[o + 1];
const be32 = (b, o) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
const le16 = (b, o) => b[o] | (b[o + 1] << 8);
const le24 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + ((b[o + 3] << 24) >>> 0);

async function read(readRange, start, end) {
  const bytes = await readRange(start, end);
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/**
 * The picture in a file of `size` bytes, as an <img> shows it: { type,
 * width, height }, orientation applied. Null when the header does not say it
 * for certain (above), or is not one this reads.
 */
export async function imageHeaderSize(readRange, { size } = {}) {
  const total = Number(size);
  if (!(total > 0)) return null;
  const head = await read(readRange, 0, Math.min(HEAD, total));
  const at = (o, n) => (o + n <= head.length ? head.subarray(o, o + n) : read(readRange, o, Math.min(o + n, total)));
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return jpegSize(at, total);
  if (head.length >= 8 && text(head, 0, 8) === '\x89PNG\r\n\x1a\n') return pngSize(at, total);
  if (head.length >= 12 && text(head, 0, 4) === 'RIFF' && text(head, 8, 4) === 'WEBP') return webpSize(head);
  return null;
}

/**
 * The orientation in a TIFF structure (an EXIF block's body) at
 * `b[start..end)`: 1–8, 1 when it says none — or null when it cannot be read,
 * says it twice, or says it in any form but the one SHORT every browser reads.
 */
export function exifOrientation(b, start = 0, end = b.length) {
  if (end - start < 8) return null;
  const order = text(b, start, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const u16 = (o) => (le ? le16(b, o) : be16(b, o));
  const u32 = (o) => (le ? le32(b, o) : be32(b, o));
  if (u16(start + 2) !== 42) return null;
  const ifd = start + u32(start + 4);
  if (ifd + 2 > end) return null;
  const count = u16(ifd);
  if (ifd + 2 + count * 12 > end) return null;
  let orientation = 0;
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (u16(e) !== TAG_ORIENTATION) continue;
    const value = u16(e + 8);
    if (orientation || u16(e + 2) !== SHORT || u32(e + 4) !== 1 || value < 1 || value > 8) return null;
    orientation = value;
  }
  return orientation || 1;
}

/** An XMP packet's tiff:Orientation, attribute or element; null when it has none. */
function xmpOrientation(b) {
  // Up to 64 KB: a few thousand characters at a time, not one call with all of them.
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += text(b, i, Math.min(8192, b.length - i));
  const m = /tiff:Orientation\s*(?:=\s*["']\s*|>\s*)(\d+)/.exec(s);
  return m ? Number(m[1]) : null;
}

async function jpegSize(at, total) {
  let frame = null;
  let exif = null;   // the EXIF orientation, once read
  let xmp = null;    // XMP's, when it says one
  let app1 = 0;
  let o = 2;
  const end = Math.min(total, MAX_SCAN);
  for (let i = 0; i < MAX_STEPS && o + 4 <= end; i++) {
    // A segment's marker and length, and enough past them to tell an APP1's
    // kind or read a frame header's size.
    const h = await at(o, 4 + XMP_ID.length);
    if (h.length < 4 || h[0] !== 0xff) return null;
    const marker = h[1];
    if (marker === 0xff) { o += 1; continue; }                                      // fill byte
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { o += 2; continue; } // no length: TEM, RSTn, SOI
    if (marker === 0xd9) return null;                                                // the end, and no picture
    if (marker === 0xda) {
      // The image data: whatever says anything about the picture is behind.
      if (!frame) return null;
      const orientation = exif ?? 1;
      if (xmp !== null && xmp !== orientation) return null;
      const turned = orientation >= 5;
      return { type: 'jpeg', width: turned ? frame.height : frame.width, height: turned ? frame.width : frame.height };
    }
    const length = be16(h, 2);
    if (length < 2) return null;
    if (marker === 0xe1) {
      app1 += 1;
      if (h.length >= 4 + EXIF_ID.length && text(h, 4, EXIF_ID.length) === EXIF_ID) {
        // Firefox reads the first APP1 only, Chrome the first with EXIF in
        // it: an EXIF block behind another APP1, or a second one, is read
        // differently by the two.
        if (app1 > 1 || exif !== null) return null;
        const seg = await at(o + 4, length - 2);
        exif = exifOrientation(seg, EXIF_ID.length, seg.length);
        if (exif === null) return null;
      } else if (h.length >= 4 + XMP_ID.length && text(h, 4, XMP_ID.length) === XMP_ID) {
        xmp = xmpOrientation(await at(o + 4, length - 2)) ?? xmp;
      }
    } else if (SOF.has(marker)) {
      if (frame || h.length < 9) return null;
      frame = { height: be16(h, 5), width: be16(h, 7) };
      // A height of 0 is given later, by a DNL segment: not worth reading.
      if (!frame.width || !frame.height) return null;
    }
    o += 2 + length;
  }
  return null;
}

async function pngSize(at, total) {
  const ihdr = await at(8, 16);
  if (ihdr.length < 16 || text(ihdr, 4, 4) !== 'IHDR') return null;
  const width = be32(ihdr, 8);
  const height = be32(ihdr, 12);
  if (!width || !height) return null;
  let o = 8;
  const end = Math.min(total, MAX_SCAN);
  for (let i = 0; i < MAX_STEPS && o + 8 <= end; i++) {
    const h = await at(o, 8);
    if (h.length < 8) return null;
    const type = text(h, 4, 4);
    if (type === 'IDAT') return { type: 'png', width, height };
    if (type === 'eXIf') return null;
    o += 12 + be32(h, 0);
  }
  return null;
}

function webpSize(b) {
  if (b.length < 30) return null;
  const chunk = text(b, 12, 4);
  let width = 0;
  let height = 0;
  if (chunk === 'VP8 ') {
    // Lossy: a key frame's start code, then 14 bits of each dimension.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    width = le16(b, 26) & 0x3fff;
    height = le16(b, 28) & 0x3fff;
  } else if (chunk === 'VP8L') {
    // Lossless: a signature byte, then each dimension less one in 14 bits.
    if (b[20] !== 0x2f) return null;
    const bits = le32(b, 21);
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
  } else if (chunk === 'VP8X') {
    // Extended: flags, then the canvas, each dimension less one in 24 bits.
    if (b[20] & 0x08) return null; // EXIF
    width = le24(b, 24) + 1;
    height = le24(b, 27) + 1;
  } else {
    return null;
  }
  return width && height ? { type: 'webp', width, height } : null;
}
