// lib/exif-orientation.js — which way up a photo's pixels go.
//
// A camera stores the sensor's pixels as they came off it and says in EXIF
// how to turn them (tag 0x0112, 1–8). Browsers turn them when they draw an
// <img>, and createImageBitmap does when asked (`imageOrientation:
// 'from-image'`) in the browsers that know the option — but not in every one,
// and a sideways download is the whole bug. So the converter
// (lib/image-convert.js) reads the tag itself, checks once whether this
// browser's decoder already applied it (a tiny probe picture), and turns the
// pixels on the canvas when it did not.
//
// Pure: bytes in, numbers out. Only JPEG (EXIF in APP1) and TIFF (the tag in
// the first directory) are read: a HEIC's rotation is part of the picture
// itself (irot/imir), which the decoder applies, and PNG and WebP almost never
// carry one.

/** The orientation (1–8) the start of a JPEG or TIFF file says, or 1 when it says none. */
export function exifOrientation(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  if (b.length < 4) return 1;
  if (isTiffHeader(b, 0)) return tiffOrientation(b, 0, b.length);
  if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return 1;
    const marker = b[i + 1];
    // Fill bytes before a marker.
    if (marker === 0xff) { i += 1; continue; }
    // The picture itself, or the end: no metadata past here.
    if (marker === 0xda || marker === 0xd9) return 1;
    // Markers with no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return 1;
    const end = Math.min(b.length, i + 2 + len);
    // APP1 "Exif\0\0", then a TIFF header.
    if (marker === 0xe1 && end - i >= 18
      && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66 && b[i + 8] === 0 && b[i + 9] === 0) {
      return tiffOrientation(b, i + 10, end);
    }
    i += 2 + len;
  }
  return 1;
}

function isTiffHeader(b, at) {
  return (b[at] === 0x49 && b[at + 1] === 0x49 && b[at + 2] === 0x2a && b[at + 3] === 0)
    || (b[at] === 0x4d && b[at + 1] === 0x4d && b[at + 2] === 0 && b[at + 3] === 0x2a);
}

/** The orientation in the first directory of the TIFF structure at `start` (offsets count from it), within `end`. */
function tiffOrientation(b, start, end) {
  if (start + 8 > end || !isTiffHeader(b, start)) return 1;
  const le = b[start] === 0x49;
  const u16 = (o) => (o + 2 > end ? -1 : le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o) => (o + 4 > end ? -1 : le
    ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000
    : b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]));
  const offset = u32(start + 4);
  if (offset < 8) return 1;
  const ifd = start + offset;
  const count = u16(ifd);
  if (count <= 0) return 1;
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) return 1;
    if (u16(e) !== 0x0112) continue;
    const type = u16(e + 2);
    // SHORT, as the standard has it; a LONG from a careless writer is read too.
    const v = type === 3 ? u16(e + 8) : type === 4 ? u32(e + 8) : 0;
    return v >= 1 && v <= 8 ? v : 1;
  }
  return 1;
}

/** Orientations 5–8 turn the picture a quarter: its width and height trade places. */
export function swapsAxes(orientation) {
  return orientation >= 5 && orientation <= 8;
}

/** A `{ width, height }` as it is shown once `orientation` is applied. */
export function orientedSize(size, orientation) {
  const width = Number(size?.width);
  const height = Number(size?.height);
  return swapsAxes(orientation) ? { width: height, height: width } : { width, height };
}

/**
 * The canvas transform (setTransform's a, b, c, d, e, f) that draws stored
 * pixels, drawn at `width` × `height`, the right way up into a canvas of the
 * oriented size — `height` × `width` for 5–8. The standard table: each maps
 * the stored picture's corners onto where the camera meant them.
 */
export function orientationTransform(orientation, width, height) {
  switch (orientation) {
    case 2: return [-1, 0, 0, 1, width, 0]; // mirrored
    case 3: return [-1, 0, 0, -1, width, height]; // upside down
    case 4: return [1, 0, 0, -1, 0, height]; // mirrored, upside down
    case 5: return [0, 1, 1, 0, 0, 0]; // mirrored, a quarter anticlockwise
    case 6: return [0, 1, -1, 0, height, 0]; // a quarter clockwise
    case 7: return [0, -1, -1, 0, height, width]; // mirrored, a quarter clockwise
    case 8: return [0, -1, 1, 0, 0, width]; // a quarter anticlockwise
    default: return [1, 0, 0, 1, 0, 0];
  }
}
