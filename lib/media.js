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

/** 'image' or 'video' when a browser can probably draw a frame of it, else null. */
export function drawableKind(file) {
  const mime = String(file?.mime || '').toLowerCase();
  const name = String(file?.name || '');
  const kind = effectiveKind(file);
  if (kind === 'image' && (IMAGE_TYPES.test(mime) || (!mime.startsWith('image/') && IMAGE_EXT.test(name)))) return 'image';
  if (kind === 'video' && (VIDEO_TYPES.test(mime) || (!mime.startsWith('video/') && VIDEO_EXT.test(name)))) return 'video';
  return null;
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

/** Width, height and duration from a client, kept only when they are sane numbers. */
export function mediaFacts(input) {
  const out = {};
  for (const k of ['width', 'height', 'duration']) {
    const v = Number(input?.[k]);
    if (Number.isFinite(v) && v > 0 && v < 1e7) out[k] = k === 'duration' ? Math.round(v * 10) / 10 : Math.round(v);
  }
  return out;
}

const KINDS = new Set(['image', 'video', 'audio', 'doc', 'other']);

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
  const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : {};
  return {
    kind: KINDS.has(body.kind) ? body.kind : fileKind(body.mime, body.name),
    thumbnailKey: isThumbKey(body.thumbnailKey) ? body.thumbnailKey : null,
    thumbnailUrl: null,
    metadata: { ...metadata, ...mediaFacts(body.media) },
  };
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
