// lib/media.js — what a file is, and whether a browser can draw it.
//
// Plain functions with no imports, shared by the server (classifying an
// upload, validating a thumbnail key) and the browser (choosing between a
// thumbnail, the original and a placeholder).

/** Classify a file for the manager's type filter + icons. */
export function fileKind(mime = '', name = '') {
  const m = (mime || '').toLowerCase();
  const n = (name || '').toLowerCase();
  if (m.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg|avif|heic|heif|tiff?)$/.test(n)) return 'image';
  if (m.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv)$/.test(n)) return 'video';
  if (m.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac)$/.test(n)) return 'audio';
  if (/pdf|msword|wordprocessing|spreadsheet|presentation|text\/|csv/.test(m) || /\.(pdf|docx?|xlsx?|csv|txt|pptx?|key|pages)$/.test(n)) return 'doc';
  return 'other';
}

/**
 * The kind to render a row as. Web uploads were recorded as 'other' until the
 * server started classifying them, so an 'other' row is classified again from
 * its mime type and name.
 */
export function effectiveKind(file) {
  const k = file?.kind;
  return k && k !== 'other' ? k : fileKind(file?.mime, file?.name);
}

// Formats every current browser decodes in an <img>. TIFF, HEIC and camera RAW
// are missing on purpose: Chrome renders them as a broken image.
const IMAGE_TYPES = /^image\/(jpeg|png|gif|webp|avif|bmp)$/;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;
// Containers worth trying in a <video>. A MOV may hold ProRes, which only
// Safari decodes; the attempt fails fast and the file keeps its placeholder.
const VIDEO_TYPES = /^video\/(mp4|webm|quicktime|x-m4v|ogg)$/;
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv)$/i;

// Formats only some browsers decode (Safari 17+ does both), accepted when a
// probe in this browser has shown it can (lib/decode-probe.js).
const HEIC_TYPES = /^image\/(heic|heif)(-sequence)?$/;
const HEIC_EXT = /\.(heic|heif)$/i;
const TIFF_TYPES = /^image\/tiff?$/;
const TIFF_EXT = /\.tiff?$/i;

/**
 * 'image' or 'video' when a browser can probably draw a frame of it, else
 * null. `probe` is { heic, tiff } from lib/decode-probe.js: what this browser
 * was seen to decode, which adds those formats.
 */
export function drawableKind(file, { probe } = {}) {
  const mime = String(file?.mime || '').toLowerCase();
  const name = String(file?.name || '');
  const kind = effectiveKind(file);
  if (kind === 'image' && (IMAGE_TYPES.test(mime) || (!mime.startsWith('image/') && IMAGE_EXT.test(name)))) return 'image';
  if (kind === 'image' && probe?.heic && (HEIC_TYPES.test(mime) || HEIC_EXT.test(name))) return 'image';
  if (kind === 'image' && probe?.tiff && (TIFF_TYPES.test(mime) || TIFF_EXT.test(name))) return 'image';
  if (kind === 'video' && (VIDEO_TYPES.test(mime) || (!mime.startsWith('video/') && VIDEO_EXT.test(name)))) return 'video';
  return null;
}

/**
 * Whether a new cover may be offered for `file` (to someone who may edit it):
 * a video the browser can draw a frame of, in the bucket, where previews go.
 * The thumbnail routes decide the rest (files.edit, canModifyFile).
 */
export function coverChangeable(file) {
  return file?.storage === 's3' && drawableKind(file) === 'video';
}

// An original bigger than this is never decoded just to make a thumbnail: a
// 60 MB PNG is several hundred megabytes of pixels in a tab.
export const THUMB_SOURCE_MAX_BYTES = 50 * 1024 * 1024;
// Nor is it put in a grid tile while it has no thumbnail.
export const GRID_ORIGINAL_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Thumbnails live under `_thumbs/` at the bucket root, named by the server.
 * Anything else offered as a thumbnail key is refused, so a client cannot
 * point a row's preview at some other object.
 */
export function isThumbKey(key) {
  return typeof key === 'string' && /^_thumbs\/[0-9a-f-]{36}\.(webp|jpg)$/.test(key);
}

/**
 * A hover-scrub sprite sheet, named by the server as
 * `_thumbs/<uuid>.strip.webp`.
 *
 * Under `_thumbs/` on purpose rather than a prefix of its own: the listing
 * already excludes that path, and the predicate doing the excluding is the one
 * evaluated per row for every page of the library. Adding a term to it to hide
 * a second prefix would cost something on every read forever.
 *
 * The `.strip` segment is what keeps the two apart — isThumbKey does not match
 * a strip, and this does not match a thumbnail, so neither can be recorded in
 * the other's column.
 */
export function isFilmstripKey(key) {
  return typeof key === 'string' && /^_thumbs\/[0-9a-f-]{36}\.strip\.webp$/.test(key);
}

/**
 * A video's player poster — the grid thumbnail's frame at up to 1920px, for
 * the detail page (lib/poster.js) — named by the server as
 * `_thumbs/<uuid>.poster.webp` (or `.jpg`, from a browser with no WebP
 * encoder). The `.poster` segment keeps it out of the other two columns, as
 * `.strip` does for a filmstrip.
 */
export function isPosterKey(key) {
  return typeof key === 'string' && /^_thumbs\/[0-9a-f-]{36}\.poster\.(webp|jpg)$/.test(key);
}

/** Previews never change under their keys, so a browser may keep one a year. The PUT must send it: S3 stores it. */
export const PREVIEW_CACHE_CONTROL = 'private, max-age=31536000, immutable';

/**
 * The thumbnail's smaller siblings (lib/poster.js SM_POSTER_BOX and
 * XS_POSTER_BOX), in the order they are listed in `files.thumb_sizes`.
 */
export const THUMB_SIZES = Object.freeze(['sm', 'xs']);

/**
 * A sibling's key: the grid thumbnail's, with `.sm` or `.xs` before the
 * extension — `_thumbs/<uuid>.sm.webp`. Derived on the server from a row's
 * thumbnail key, and only from one the presign route named (isThumbKey), so
 * a client can never point a sibling at another object: nothing a client
 * sends is ever taken as a sibling key. Null for anything else.
 */
export function thumbSiblingKey(thumbKey, size) {
  if (!isThumbKey(thumbKey) || !THUMB_SIZES.includes(size)) return null;
  return thumbKey.replace(/\.(webp|jpg)$/, `.${size}.$1`);
}

/**
 * A sibling key as thumbSiblingKey makes it. Like `.strip` and `.poster`, the
 * size segment keeps it out of every other preview column: isThumbKey,
 * isPosterKey and isFilmstripKey all refuse it.
 */
export function isThumbSiblingKey(key) {
  return typeof key === 'string' && /^_thumbs\/[0-9a-f-]{36}\.(sm|xs)\.(webp|jpg)$/.test(key);
}

/**
 * The sibling sizes a client says it uploaded, kept only when they are known
 * sizes: a de-duplicated array in THUMB_SIZES order, or null for none. The
 * keys themselves are never taken from the client (thumbSiblingKey).
 */
export function thumbSizesFrom(input) {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [];
  const want = new Set(list.map((v) => String(v).trim()));
  const out = THUMB_SIZES.filter((s) => want.has(s));
  return out.length ? out : null;
}

/**
 * The filmstrip geometry a client reports, kept only when every field is sane.
 *
 * These numbers become CSS background offsets, so a wrong one silently shifts
 * every tile in the sheet. All-or-nothing: a partial layout cannot position
 * anything, and storing one would leave the player computing offsets from
 * undefined.
 */
export function filmstripFacts(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const k of ['frames', 'columns', 'tileWidth', 'tileHeight']) {
    const v = Number(input[k]);
    if (!Number.isInteger(v) || v <= 0 || v > 4096) return null;
    out[k] = v;
  }
  // The sheet the geometry describes must be one a browser will decode: past
  // 4096px in either axis some mobile GPUs refuse the texture outright and the
  // whole strip fails, not just the tiles beyond the limit.
  const rows = Math.ceil(out.frames / out.columns);
  if (out.columns * out.tileWidth > 4096 || rows * out.tileHeight > 4096) return null;
  return out;
}

/**
 * The frame model a probe read from the container (lib/mp4-probe.js): the
 * exact rate as a rational, the frame count, the start timecode in frames and
 * whether it is drop-frame. Kept only as a set anchored on a valid rate — a
 * frame count or a start timecode means nothing without the rate it counts
 * at, and a comment pinned against a half-valid model reopens on the wrong
 * frame.
 */
export function frameFacts(input) {
  const fps = input?.fps;
  const num = Number(fps?.num);
  const den = Number(fps?.den);
  const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!intIn(num, 1, 2 ** 31) || !intIn(den, 1, 2 ** 31)) return {};
  // One frame a second to a thousand: outside that is a misread box.
  if (num / den < 1 || num / den > 1000) return {};
  const out = { fps: { num, den } };
  const frames = Number(input.frames);
  if (intIn(frames, 1, 1e9)) out.frames = frames;
  // Twenty-four hours at 1000fps is the most a start timecode can be.
  const tcStart = input.tcStart == null ? 0 : Number(input.tcStart);
  out.tcStart = intIn(tcStart, 0, 86400 * 1000) ? tcStart : 0;
  out.dropFrame = input.dropFrame === true;
  return out;
}

/**
 * Width, height and duration from a client, kept only when they are sane
 * numbers — and the frame model (frameFacts) when one was probed.
 */
export function mediaFacts(input) {
  const out = {};
  for (const k of ['width', 'height', 'duration']) {
    const v = Number(input?.[k]);
    if (Number.isFinite(v) && v > 0 && v < 1e7) out[k] = k === 'duration' ? Math.round(v * 10) / 10 : Math.round(v);
  }
  return { ...out, ...frameFacts(input) };
}

const KINDS = new Set(['image', 'video', 'audio', 'doc', 'other']);

/**
 * Metadata keys that describe the media itself and are the server's to fill
 * in from what it has checked: the picture's size and length, the frame model
 * (frameFacts), the filmstrip's geometry, and the probe's mark for a file it
 * could not read. A client's `metadata`, and a metadata edit, may carry the
 * library's own fields but none of these as sent.
 */
export const MEDIA_KEYS = Object.freeze([
  'width', 'height', 'duration', 'fps', 'frames', 'tcStart', 'dropFrame', 'fpsUnknown', 'filmstrip',
]);

/**
 * The fields of an upload registration the server decides rather than takes
 * from the body as sent.
 *
 * The uploader never sent a kind, so every web upload was stored as 'other':
 * no preview in the grid, no player on the detail page, and missing from the
 * Images and Video filters. A thumbnail is only ever a key the presign route
 * named; the listing signs it, so a client-supplied thumbnail URL is dropped.
 */
export function uploadFields(body = {}) {
  const sent = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : {};
  // The body's own `metadata` keeps the library's fields. Of the media's, the
  // size and length are checked like `media`'s; the frame model comes only
  // from `media` — the one place the browser's probe puts it, checked whole
  // by frameFacts — because a rate or a start timecode taken as sent is every
  // comment pinned to the wrong frame, and a model half from each would be
  // one no probe read. A client's `fpsUnknown` would stop the detail page
  // from ever reading the real rate, and a filmstrip only comes with its key.
  const metadata = {
    ...Object.fromEntries(Object.entries(sent).filter(([k]) => !MEDIA_KEYS.includes(k))),
    ...mediaFacts({ width: sent.width, height: sent.height, duration: sent.duration }),
  };
  // A filmstrip is kept only when BOTH halves check out: a key the presign
  // route named, and a geometry that describes a decodable sheet. A key with
  // no geometry would leave the player unable to place a tile; a geometry with
  // no key would have it fetch nothing.
  const strip = isFilmstripKey(body.filmstripKey) ? filmstripFacts(body.filmstrip) : null;
  const thumbnailKey = isThumbKey(body.thumbnailKey) ? body.thumbnailKey : null;
  return {
    kind: KINDS.has(body.kind) ? body.kind : fileKind(body.mime, body.name),
    thumbnailKey,
    thumbnailUrl: null,
    // A player poster (or an image's large preview) is the thumbnail's
    // picture at a larger size, so it is kept only alongside a thumbnail, as
    // are the thumbnail's smaller siblings — whose keys are derived from the
    // thumbnail's, never sent.
    posterKey: thumbnailKey && isPosterKey(body.posterKey) ? body.posterKey : null,
    thumbSizes: thumbnailKey ? thumbSizesFrom(body.thumbSizes) : null,
    filmstripKey: strip ? body.filmstripKey : null,
    metadata: { ...metadata, ...mediaFacts(body.media), ...(strip ? { filmstrip: strip } : {}) },
  };
}

const COMMON_RATIOS = [[1, 1], [4, 5], [5, 4], [9, 16], [16, 9], [3, 4], [4, 3], [2, 3], [3, 2], [9, 21], [21, 9]];

/** 1920 × 1080 → "16:9": the nearest of the ratios people name. */
export function aspectLabel(w, h) {
  if (!w || !h) return null;
  const r = w / h;
  let best = null, bd = Infinity;
  for (const [a, b] of COMMON_RATIOS) { const d = Math.abs(r - a / b); if (d < bd) { bd = d; best = `${a}:${b}`; } }
  return best;
}

/** "Take 2.MOV" → "MOV"; with no extension, the mime type's subtype; else null. */
export function fileFormat(name = '', mime = '') {
  const m = String(name || '').split('?')[0].match(/\.([a-z0-9]+)$/i);
  if (m) return m[1].toUpperCase();
  const sub = String(mime || '').split('/')[1];
  return sub ? sub.split(';')[0].toUpperCase() : null;
}

/** 1536 → "1.5 KB", 0 or nothing → "". Binary units, as a file manager shows them. */
export function fmtSize(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

/** 83.4 → "1:23", 3725 → "1:02:05". */
export function fmtDuration(seconds) {
  const s = Math.round(Number(seconds));
  if (!Number.isFinite(s) || s <= 0) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
