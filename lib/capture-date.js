// lib/capture-date.js — when a photo was taken, read from the file at upload.
//
// A browser hands over a File with a lastModified and nothing more: no
// creation date, and no capture date. A photo carries its own, in EXIF —
// DateTimeOriginal, with OffsetTimeOriginal since EXIF 2.31 — and that is the
// date a photo library files it under. This reads it from a JPEG (the APP1
// segment near the start) or a HEIC/HEIF/AVIF (the 'Exif' item the meta box
// points at), in two or three small reads of the local file: the pixels are
// never decoded. A video's is lib/mp4-probe.js's (the mvhd creation time).
//
// Import-free and isomorphic. It reads through an injected
// `readRange(start, end) → Uint8Array` (end exclusive, like File.slice), as
// mp4-probe does, so the tests hand it bytes.

// JPEG: the APP1 segment sits within the first few KB in practice, so the
// first read takes 64 KB and any header past it is read on its own.
const JPEG_HEAD = 64 * 1024;
const MAX_JPEG_SEGMENTS = 64;
// HEIF: the top-level walk reads a 16-byte header per box, and a real file
// has a handful before its meta box.
const MAX_TOP_LEVEL_BOXES = 64;
// A meta box or an Exif item larger than these is not read.
const MAX_META_BYTES = 1024 * 1024;
const MAX_EXIF_BYTES = 256 * 1024;

const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis']);

const TAG_EXIF_IFD = 0x8769;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;
const TAG_OFFSET_ORIGINAL = 0x9011;
const TAG_OFFSET_DIGITIZED = 0x9012;
const ASCII = 2;
const LONG = 4;

const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const be16 = (b, o) => (b[o] << 8) | b[o + 1];
const be32 = (b, o) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
const beN = (b, o, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[o + i]; return v; };

async function read(readRange, start, end) {
  const bytes = await readRange(start, end);
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/**
 * "2026:09:05 14:30:00" (+ "+02:00") → epoch ms, or null. Without an offset
 * the time is the camera's clock, taken as local time here — the uploader's
 * zone, which is where most photos are taken. `local` is how local time
 * becomes an instant (the tests pass their own).
 */
export function exifDateTime(text, offset = null, { local = (y, mo, d, h, mi, s) => new Date(y, mo - 1, d, h, mi, s).getTime() } = {}) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(text || '').trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (y < 1970 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const o = /^([+-])(\d{2}):(\d{2})$/.exec(String(offset || '').trim());
  if (o) {
    const minutes = (Number(o[2]) * 60 + Number(o[3])) * (o[1] === '-' ? -1 : 1);
    return Date.UTC(y, mo - 1, d, h, mi, s) - minutes * 60_000;
  }
  const ms = local(y, mo, d, h, mi, s);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The capture date in a TIFF structure (an EXIF block's body) at
 * `bytes[start..end)`: DateTimeOriginal, else DateTimeDigitized, each with
 * its offset when there is one. null when there is none or it is unreadable.
 */
export function tiffCaptureDate(bytes, start = 0, end = bytes.length, opts) {
  if (end - start < 8) return null;
  const order = fourcc(bytes, start).slice(0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const u16 = (o) => (le ? bytes[o] | (bytes[o + 1] << 8) : be16(bytes, o));
  const u32 = (o) => (le ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) + ((bytes[o + 3] << 24) >>> 0) : be32(bytes, o));
  const inside = (o, n) => o >= start && o + n <= end;
  if (u16(start + 2) !== 42) return null;

  // One IFD's entries: tag → { type, count, at } where `at` is the value's offset.
  const ifd = (offset) => {
    const at = start + offset;
    if (!inside(at, 2)) return null;
    const count = u16(at);
    if (count > 1024 || !inside(at + 2, count * 12)) return null;
    const out = new Map();
    for (let i = 0; i < count; i++) {
      const e = at + 2 + i * 12;
      const type = u16(e + 2);
      const n = u32(e + 4);
      const size = type === ASCII ? n : type === LONG ? n * 4 : 0;
      out.set(u16(e), { type, count: n, at: size <= 4 ? e + 8 : start + u32(e + 8) });
    }
    return out;
  };
  const ascii = (tags, tag) => {
    const t = tags?.get(tag);
    if (!t || t.type !== ASCII || t.count > 64 || !inside(t.at, t.count)) return null;
    let s = '';
    for (let i = 0; i < t.count && bytes[t.at + i]; i++) s += String.fromCharCode(bytes[t.at + i]);
    return s;
  };

  const ifd0 = ifd(u32(start + 4));
  const pointer = ifd0?.get(TAG_EXIF_IFD);
  if (!pointer || pointer.type !== LONG || !inside(pointer.at, 4)) return null;
  const exif = ifd(u32(pointer.at));
  if (!exif) return null;
  return exifDateTime(ascii(exif, TAG_DATETIME_ORIGINAL), ascii(exif, TAG_OFFSET_ORIGINAL), opts)
    ?? exifDateTime(ascii(exif, TAG_DATETIME_DIGITIZED), ascii(exif, TAG_OFFSET_DIGITIZED), opts);
}

/** A JPEG's EXIF block, its APP1 segment; null when it has none ahead of the image data. */
async function jpegExif(readRange, size) {
  const head = await read(readRange, 0, Math.min(JPEG_HEAD, size));
  const at = (o, n) => (o + n <= head.length ? head.subarray(o, o + n) : read(readRange, o, Math.min(o + n, size)));
  let o = 2;
  for (let i = 0; i < MAX_JPEG_SEGMENTS && o + 4 <= size; i++) {
    const h = await at(o, 4);
    if (h.length < 4 || h[0] !== 0xff) return null;
    const marker = h[1];
    if (marker === 0xff) { o += 1; continue; }              // fill byte
    if (marker === 0xd9 || marker === 0xda) return null;   // end of image, or the image data: no EXIF ahead of it
    const length = be16(h, 2);
    if (length < 2) return null;
    if (marker === 0xe1) {
      const seg = await at(o, 2 + length);
      if (seg.length >= 10 && fourcc(seg, 4) === 'Exif' && seg[8] === 0 && seg[9] === 0) return seg;
    }
    o += 2 + length;
  }
  return null;
}

/** The child boxes of `bytes[start..end)`: [{ type, start, end, body }]; stops at the first bad header. */
function boxes(bytes, start, end) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = be32(bytes, o);
    let header = 8;
    if (size === 1) {
      if (o + 16 > end) break;
      size = beN(bytes, o + 8, 8);
      header = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < header || o + size > end) break;
    out.push({ type: fourcc(bytes, o + 4), start: o, end: o + size, body: o + header });
    o += size;
  }
  return out;
}

/**
 * The extents of the item whose type is 'Exif', from a meta box read whole:
 * { id, method, extents: [{ offset, length }] } — `offset` is absolute in
 * the file (construction method 0) or into the meta's idat (method 1). null
 * when there is no such item or the boxes cannot be read.
 */
export function heifExifItem(meta) {
  // A FullBox: four bytes of version and flags, then the children.
  const kids = boxes(meta, 4, meta.length);
  const iinf = kids.find((b) => b.type === 'iinf');
  const iloc = kids.find((b) => b.type === 'iloc');
  if (!iinf || !iloc) return null;

  let id = null;
  const iinfVersion = meta[iinf.body];
  const first = iinf.body + 4 + (iinfVersion === 0 ? 2 : 4);
  for (const infe of boxes(meta, first, iinf.end)) {
    if (infe.type !== 'infe') continue;
    const v = meta[infe.body];
    if (v < 2) continue; // versions 0 and 1 have no item type
    const idAt = infe.body + 4;
    const typeAt = idAt + (v === 2 ? 2 : 4) + 2;
    if (typeAt + 4 > infe.end) continue;
    if (fourcc(meta, typeAt) === 'Exif') { id = v === 2 ? be16(meta, idAt) : be32(meta, idAt); break; }
  }
  if (id == null) return null;

  let o = iloc.body;
  const v = meta[o];
  o += 4;
  if (o + 2 > iloc.end) return null;
  const offsetSize = meta[o] >> 4;
  const lengthSize = meta[o] & 15;
  const baseSize = meta[o + 1] >> 4;
  const indexSize = v === 1 || v === 2 ? meta[o + 1] & 15 : 0;
  o += 2;
  const need = (n) => o + n <= iloc.end;
  if (!need(v < 2 ? 2 : 4)) return null;
  const count = v < 2 ? be16(meta, o) : be32(meta, o);
  o += v < 2 ? 2 : 4;
  for (let i = 0; i < count; i++) {
    if (!need(v < 2 ? 2 : 4)) return null;
    const itemId = v < 2 ? be16(meta, o) : be32(meta, o);
    o += v < 2 ? 2 : 4;
    let method = 0;
    if (v === 1 || v === 2) { if (!need(2)) return null; method = be16(meta, o) & 15; o += 2; }
    if (!need(2 + baseSize + 2)) return null;
    o += 2; // data_reference_index
    const base = beN(meta, o, baseSize);
    o += baseSize;
    const extentCount = be16(meta, o);
    o += 2;
    const extents = [];
    for (let e = 0; e < extentCount; e++) {
      if (!need(indexSize + offsetSize + lengthSize)) return null;
      o += indexSize;
      const offset = beN(meta, o, offsetSize);
      o += offsetSize;
      const length = beN(meta, o, lengthSize);
      o += lengthSize;
      extents.push({ offset: base + offset, length });
    }
    if (itemId === id) return { id, method, extents };
  }
  return null;
}

/** A HEIF's (HEIC, AVIF) EXIF block, the 'Exif' item its meta box points at. */
async function heifExif(readRange, size) {
  let o = 0;
  let meta = null;
  for (let i = 0; i < MAX_TOP_LEVEL_BOXES && o + 8 <= size && !meta; i++) {
    const head = await read(readRange, o, Math.min(o + 16, size));
    let boxSize = be32(head, 0);
    let header = 8;
    if (boxSize === 1) {
      if (head.length < 16) return null;
      boxSize = beN(head, 8, 8);
      header = 16;
    } else if (boxSize === 0) {
      boxSize = size - o;
    }
    if (boxSize < header || o + boxSize > size) return null;
    if (fourcc(head, 4) === 'meta') {
      if (boxSize > MAX_META_BYTES) return null;
      meta = await read(readRange, o + header, o + boxSize);
    }
    o += boxSize;
  }
  if (!meta) return null;
  const item = heifExifItem(meta);
  if (!item || item.extents.length !== 1) return null;
  const { offset, length } = item.extents[0];
  if (length < 10 || length > MAX_EXIF_BYTES) return null;
  let data;
  if (item.method === 0) {
    if (offset + length > size) return null;
    data = await read(readRange, offset, offset + length);
  } else if (item.method === 1) {
    const idat = boxes(meta, 4, meta.length).find((b) => b.type === 'idat');
    if (!idat || idat.body + offset + length > idat.end) return null;
    data = meta.subarray(idat.body + offset, idat.body + offset + length);
  } else {
    return null;
  }
  return data;
}

/**
 * When a photo was taken, epoch ms, or null: a JPEG's or a HEIF's EXIF
 * DateTimeOriginal (DateTimeDigitized when there is no original), at its
 * OffsetTimeOriginal when it has one. Told apart by their first bytes, not
 * by name or type. Throws only when a read fails; a file this cannot read,
 * or one that says nothing, is null.
 */
export async function photoCaptureDate(readRange, { size, ...opts } = {}) {
  const total = Number(size);
  if (typeof readRange !== 'function' || !Number.isFinite(total) || total < 16) return null;
  const magic = await read(readRange, 0, 12);
  if (magic[0] === 0xff && magic[1] === 0xd8) {
    // The APP1 segment: "Exif\0\0", then the TIFF structure.
    const seg = await jpegExif(readRange, total);
    return seg ? tiffCaptureDate(seg, 10, seg.length, opts) : null;
  }
  if (fourcc(magic, 4) === 'ftyp' && HEIF_BRANDS.has(fourcc(magic, 8))) {
    // The item starts with where its TIFF header is, past an "Exif\0\0" prefix.
    const data = await heifExif(readRange, total);
    if (!data || data.length < 8) return null;
    const tiff = 4 + be32(data, 0);
    return tiff < data.length ? tiffCaptureDate(data, tiff, data.length, opts) : null;
  }
  return null;
}
