// lib/download-formats.js — what a file can be downloaded as, how big, and
// what the copy is called.
//
// Pure, and shared: the Download-as dialog decides what to offer from it
// (app/components/download/), the browser's converter sizes a copy with it
// (lib/image-convert.js), and the download routes name what they serve with
// it (lib/download-variants.js), so an offer and the file that arrives cannot
// disagree about a size or a name.
//
// What a file is offered:
//
//   image   Original, and copies the browser makes — JPEG, PNG, and WebP or
//           AVIF where this browser's canvas was seen to encode them — at full
//           size and at LONG_EDGES smaller than the original. Only an image
//           the browser can decode (HEIC and TIFF where lib/decode-probe.js
//           saw it do so), under the size cap, and not animated.
//   video   Original; an MP4 of H.264 and AAC at 4K, 1080p or 720p — sizes
//           at or below the source's short edge — made in this browser, or,
//           at the size its proxy is (lib/proxies.js — a 1080p H.264 copy
//           of a heavy master), the proxy itself (lib/video-formats.js has
//           the rules); and a still frame, as JPEG or PNG: the player's
//           current frame, or the video's cover.
//   else    Original only.

import { effectiveKind, drawableKind, fileFormat, fmtSize, THUMB_SOURCE_MAX_BYTES } from './media.js';
import { PROXY_MAX_HEIGHT } from './proxies.js';
import { timecode, frameAt, toRate, ASSUMED_RATE } from './video-time.js';
import { videoChoices, videoTarget, proxyShortEdge } from './video-formats.js';

/**
 * The formats a picture is converted to. JPEG and PNG every canvas encodes;
 * WebP and AVIF only some (`probed`), so they are offered only where a probe
 * of this browser's encoder said yes — asked for, a canvas that cannot
 * encode a type hands back a PNG instead, which would arrive named .webp.
 * `alpha`: whether the format keeps transparency (a JPEG is laid on white).
 */
export const IMAGE_FORMATS = Object.freeze([
  Object.freeze({ id: 'jpeg', label: 'JPEG', mime: 'image/jpeg', ext: 'jpg', quality: 0.9, alpha: false, probed: false }),
  Object.freeze({ id: 'png', label: 'PNG', mime: 'image/png', ext: 'png', quality: null, alpha: true, probed: false }),
  Object.freeze({ id: 'webp', label: 'WebP', mime: 'image/webp', ext: 'webp', quality: 0.9, alpha: true, probed: true }),
  Object.freeze({ id: 'avif', label: 'AVIF', mime: 'image/avif', ext: 'avif', quality: 0.9, alpha: true, probed: true }),
]);

/** What a still frame is saved as. */
export const STILL_FORMATS = Object.freeze(['jpeg', 'png']);

/** The smaller sizes offered, as the long edge in pixels. Only those under the original's long edge. */
export const LONG_EDGES = Object.freeze([3840, 1920, 1080]);

/**
 * The largest original the browser converts: the one the thumbnails use, for
 * the same reason — a 60 MB PNG is several hundred megabytes of pixels in a
 * tab. Past it, Original only.
 */
export const CONVERT_MAX_BYTES = THUMB_SOURCE_MAX_BYTES;

/**
 * The most pixels one canvas may hold. 16384² is Chrome's, Firefox's and
 * desktop Safari's ceiling; iOS and iPadOS Safari refuse a canvas over 4096²
 * (lib/poster.js says the same of its intermediates), so a full-size copy a
 * phone cannot draw is not offered there.
 */
export const MAX_CANVAS_PIXELS = 16384 * 16384;
export const MOBILE_MAX_CANVAS_PIXELS = 4096 * 4096;

/**
 * What the download routes serve besides the original, as `?variant=`:
 * `proxy`, a video's streamable 1080p copy; `poster`, its cover picture as
 * stored. The query string rather than a path of their own, because Onyx for
 * Mac recognises a download by its path (`/api/files/<id>/download`,
 * `/s/<token>/download` — apple/OnyxMac/WebController.swift) and takes it as
 * a download from the first request, before the redirect to the bucket.
 */
export const DOWNLOAD_VARIANTS = Object.freeze(['proxy', 'poster']);

const byId = new Map(IMAGE_FORMATS.map((f) => [f.id, f]));

/** An IMAGE_FORMATS entry by id ('jpeg', 'png', 'webp', 'avif'), or null. */
export function formatById(id) {
  return byId.get(id) || null;
}

/** `?variant=` → { variant: null } for the original, { variant } for one of DOWNLOAD_VARIANTS, or { error }. */
export function parseDownloadVariant(value) {
  if (value == null || value === '' || value === 'original') return { variant: null };
  if (DOWNLOAD_VARIANTS.includes(value)) return { variant: value };
  return { error: 'There is no such download of this file.' };
}

function dims(input) {
  const width = Number(input?.width);
  const height = Number(input?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width: Math.round(width), height: Math.round(height) };
}

/**
 * The size a copy scaled to `longEdge` comes out at: the long edge that long,
 * the aspect kept, never larger than `source` — a long edge at or past the
 * source's own is the full size. Null or nothing for `longEdge` is full size.
 * Null without usable dimensions.
 */
export function targetSize(source, longEdge = null) {
  const s = dims(source);
  if (!s) return null;
  const long = Math.max(s.width, s.height);
  const edge = Number(longEdge);
  if (longEdge == null || !Number.isFinite(edge) || edge <= 0 || edge >= long) return s;
  const scale = edge / long;
  return {
    width: Math.max(1, Math.round(s.width * scale)),
    height: Math.max(1, Math.round(s.height * scale)),
  };
}

/**
 * The sizes offered for a picture of `source` dimensions (as it is shown,
 * EXIF orientation applied): Full size, then each of LONG_EDGES under its
 * long edge — none that would be the full size again, and none with more
 * pixels than one canvas here can hold. With no dimensions on record every
 * size is offered and the copy is measured after decoding: one asked for
 * larger than the picture comes out at full size.
 */
export function sizeChoices(source, { maxPixels = MAX_CANVAS_PIXELS } = {}) {
  const s = dims(source);
  if (!s) {
    return [
      { id: 'full', longEdge: null, width: null, height: null, label: 'Full size' },
      ...LONG_EDGES.map((e) => ({ id: String(e), longEdge: e, width: null, height: null, label: `${e} px` })),
    ];
  }
  const long = Math.max(s.width, s.height);
  const out = [];
  if (s.width * s.height <= maxPixels) out.push({ id: 'full', longEdge: null, ...s, label: 'Full size' });
  for (const edge of LONG_EDGES) {
    if (edge >= long) continue;
    const t = targetSize(s, edge);
    if (t.width * t.height > maxPixels) continue;
    out.push({ id: String(edge), longEdge: edge, ...t, label: `${edge} px` });
  }
  return out;
}

/** An image row's size as recorded (width × height, as displayed), or null. */
export function recordedSize(file) {
  return dims({ width: file?.metadata?.width, height: file?.metadata?.height });
}

/**
 * Whether the browser may convert this image, as { ok } or { ok: false,
 * reason }: 'kind' (not an image), 'animated' (a GIF — a copy would be its
 * first frame), 'decode' (this browser cannot draw it: a RAW, an SVG, or a
 * HEIC or TIFF where `probe` did not see one decode), 'size' (over
 * CONVERT_MAX_BYTES), 'source' (no address to read it from).
 */
export function conversionSource(file, { probe = null, maxBytes = CONVERT_MAX_BYTES } = {}) {
  if (effectiveKind(file) !== 'image') return { ok: false, reason: 'kind' };
  const mime = String(file?.mime || '').toLowerCase();
  if (mime === 'image/gif' || (!mime.startsWith('image/') && /\.gif$/i.test(String(file?.name || '')))) return { ok: false, reason: 'animated' };
  if (drawableKind(file, { probe }) !== 'image') return { ok: false, reason: 'decode' };
  const bytes = Number(file?.size);
  if (Number.isFinite(bytes) && bytes > maxBytes) return { ok: false, reason: 'size' };
  if (!file?.url) return { ok: false, reason: 'source' };
  return { ok: true };
}

/**
 * The "p" of a video's proxy — the lines on its short side: 1080, or the
 * source's own short side below that, as Onyx for Mac makes it
 * (lib/video-formats.js proxyShortEdge). A phone clip upright is 1080 wide.
 */
export function proxyHeight(file) {
  return proxyShortEdge(file);
}

/**
 * Everything a file may be downloaded as, for the Download-as dialog:
 *
 *   { kind, original: { label, detail },
 *     formats, sizes,     an image's: IMAGE_FORMATS entries and sizeChoices;
 *                         a video's: its copies (lib/video-formats.js videoChoices rows)
 *     proxy, still,       a video's: its proxy { label, detail } when no copy is its
 *                         size, else null; { from, formats } or null
 *     videoReason,        why a video's copies cannot be made here, or null
 *     reason }            why nothing but the original, or null
 *
 * `env` is what only the page knows:
 *   probe      { heic, tiff }: what this browser decodes (lib/decode-probe.js)
 *   encoders   { webp, avif }: what its canvas encodes
 *   proxy      { available, size }: whether the video has a finished, current
 *              proxy this person may play — the row's signed proxyUrl, or the
 *              live job on the file page
 *   still      { from: 'frame' | 'cover' }: the frame a player is showing, or
 *              the video's cover picture; null when there is neither
 *   video      { convert, probe, disk }: whether this browser has WebCodecs
 *              (absent: no copies are considered); the probe of the file
 *              (lib/video-client.js), null while it runs; whether it can
 *              write a copy to disk as it goes
 *   maxPixels  the canvas ceiling here
 */
export function downloadChoices(file, env = {}) {
  const { probe = null, encoders = null, proxy = null, still = null, video = null, maxPixels = MAX_CANVAS_PIXELS } = env;
  const kind = effectiveKind(file);
  const original = {
    label: 'Original',
    detail: [fileFormat(file?.name, file?.mime), fmtSize(file?.size)].filter(Boolean).join(' · '),
  };
  if (kind === 'image') {
    const source = conversionSource(file, { probe });
    if (!source.ok) return { kind, original, formats: [], sizes: [], proxy: null, still: null, videoReason: null, reason: source.reason };
    const formats = IMAGE_FORMATS.filter((f) => !f.probed || encoders?.[f.id] === true);
    const sizes = sizeChoices(recordedSize(file), { maxPixels });
    return { kind, original, formats, sizes, proxy: null, still: null, videoReason: null, reason: sizes.length ? null : 'pixels' };
  }
  if (kind === 'video') {
    const copies = videoChoices(file, {
      probe: video?.probe ?? null, proxy, disk: video?.disk === true, convert: video?.convert === true,
    });
    // A proxy no copy is the size of (a 900p master's) is offered as itself.
    const p = proxy?.available && !copies.proxyUsed
      ? { label: `${proxyHeight(file)}p MP4 (H.264)`, detail: fmtSize(proxy.size) || 'Made for streaming' }
      : null;
    const from = still?.from === 'frame' || still?.from === 'cover' ? still.from : null;
    const s = from ? { from, formats: STILL_FORMATS.map(formatById) } : null;
    const any = copies.rows.length > 0 || p || s;
    return { kind, original, formats: [], sizes: copies.rows, proxy: p, still: s, videoReason: copies.reason, reason: any ? null : 'nothing' };
  }
  return { kind, original, formats: [], sizes: [], proxy: null, still: null, videoReason: null, reason: 'kind' };
}

/** Whether a file has anything to offer besides its original — whether "Download as…" is shown at all. */
export function offersDownloadAs(file, env = {}) {
  const c = downloadChoices(file, env);
  if (c.kind === 'image') return c.formats.length > 0 && c.sizes.length > 0;
  if (c.kind === 'video') return c.sizes.length > 0 || !!(c.proxy || c.still);
  return false;
}

// ── Names ───────────────────────────────────────────────────────────────────

// Path separators, the characters Windows refuses, and control characters.
const UNSAFE = /[\u0000-\u001f\u007f"*/:<>?\\|]/g;
// Direction overrides and isolates: "Invoice‮gpj.exe" reads as
// "Invoiceexe.jpg" in a file manager.
const BIDI = /[‎‏‪-‮⁦-⁩]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// A name is at most 255 bytes on every file system a download lands on. Well
// under, so the browser's " (1)" for a second copy still fits.
const MAX_NAME_BYTES = 200;

const utf8 = (s) => new TextEncoder().encode(s).length;

/** `s` cut to at most `bytes` of UTF-8, never through a character. */
function cutBytes(s, bytes) {
  if (utf8(s) <= bytes) return s;
  let out = '';
  for (const ch of s) {
    if (utf8(out + ch) > bytes) break;
    out += ch;
  }
  return out;
}

/** A name's own characters made safe to save: no separators, no control or reserved characters, no leading dot. */
export function sanitizeFilename(name) {
  return String(name ?? '')
    .normalize('NFC')
    .replace(BIDI, '')
    .replace(UNSAFE, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
}

/** "Take 2.final.MOV" → { base: 'Take 2.final', ext: 'MOV' }; a name with no extension (or only a leading dot) is all base. */
export function splitName(name) {
  const s = String(name ?? '');
  // [\s\S], not `.`: a name with a line break in it is still split.
  const m = s.match(/^([\s\S]+)\.([A-Za-z0-9]{1,8})$/);
  return m ? { base: m[1], ext: m[2] } : { base: s, ext: '' };
}

/**
 * What a download of `name` is saved as: its name without its extension,
 * ` (suffix)` when there is one, then `.ext` — the new format's, or the
 * original's when none is given. Made safe to save (sanitizeFilename) and cut
 * to fit, the suffix and the extension kept whole.
 *
 *   downloadName('IMG_0001.HEIC', { ext: 'jpg', suffix: '1920 px' }) → 'IMG_0001 (1920 px).jpg'
 */
export function downloadName(name, { ext = null, suffix = null } = {}) {
  const parts = splitName(name);
  const extension = sanitizeFilename(ext ?? parts.ext).replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
  const tail = `${suffix ? ` (${sanitizeFilename(suffix)})` : ''}${extension ? `.${extension}` : ''}`;
  let base = sanitizeFilename(parts.base) || 'Download';
  if (RESERVED.test(base)) base = `${base}_`;
  base = cutBytes(base, Math.max(16, MAX_NAME_BYTES - utf8(tail))).trim() || 'Download';
  return `${base}${tail}`;
}

/**
 * A converted picture: "Name.jpg" at full size, "Name (1920 px).jpg" smaller.
 * `size` is the copy's { width, height } — or, planned before the picture
 * was measured, a sizeChoices entry, whose `longEdge` is what was asked for
 * — and `source` the picture's own.
 */
export function imageDownloadName(name, { format, size = null, source = null } = {}) {
  const f = typeof format === 'string' ? formatById(format) : format;
  const out = dims(size);
  const src = dims(source);
  let edge = null;
  if (out && src) {
    const long = Math.max(out.width, out.height);
    edge = long < Math.max(src.width, src.height) ? long : null;
  } else if (Number(size?.longEdge) > 0) {
    edge = Math.round(Number(size.longEdge));
  }
  return downloadName(name, { ext: f?.ext || null, suffix: edge ? `${edge} px` : null });
}

/** A video's proxy: "Name (1080p).mp4". */
export function proxyDownloadName(name, { height = PROXY_MAX_HEIGHT } = {}) {
  const h = Number(height);
  return downloadName(name, { ext: 'mp4', suffix: `${Number.isFinite(h) && h > 0 ? Math.round(h) : PROXY_MAX_HEIGHT}p` });
}

/**
 * A video's copy at target `id` (lib/video-formats.js VIDEO_TARGETS):
 * "Name (1080p).mp4", "Name (720p).mp4", "Name (4K).mp4" — the name the
 * proxy has at its size too, so the same copy is called the same whichever
 * way it came.
 */
export function videoDownloadName(name, id) {
  const target = videoTarget(id);
  return downloadName(name, { ext: 'mp4', suffix: target ? target.name : null });
}

/** A video's cover picture: "Name (cover).jpg". */
export function coverDownloadName(name, { ext = 'jpg' } = {}) {
  return downloadName(name, { ext, suffix: 'cover' });
}

/**
 * A frame of a video, named by where it is: "Name (01.00.12.04).png" — its
 * timecode on the file's own frame model (the rate and start timecode the
 * player shows), with the separators a file name cannot hold made dots.
 */
export function frameDownloadName(name, { format, seconds = 0, metadata = {} } = {}) {
  const f = typeof format === 'string' ? formatById(format) : format;
  const fps = toRate(metadata?.fps) || ASSUMED_RATE;
  const model = { fps, tcStart: Number.isInteger(metadata?.tcStart) ? metadata.tcStart : 0, dropFrame: metadata?.dropFrame === true };
  const tc = timecode(frameAt(seconds, fps), model).replace(/[:;]/g, '.');
  return downloadName(name, { ext: f?.ext || 'jpg', suffix: tc });
}

/**
 * The format of a stored cover picture from its (signed) address: 'jpeg' for
 * one of ours saved as `.jpg` (from a browser with no WebP encoder), 'webp'
 * for `.webp`, else null — a legacy thumbnail, or no address. When it is the
 * format asked for, the cover is saved as it is (the route's `poster`
 * variant) rather than decoded and encoded again.
 */
export function storedCoverFormat(url) {
  let path = '';
  try { path = new URL(String(url || '')).pathname; } catch { return null; }
  const m = decodeURIComponent(path).match(/_thumbs\/[0-9a-f-]{36}(?:\.poster)?\.(webp|jpg)$/);
  if (!m) return null;
  return m[1] === 'jpg' ? 'jpeg' : 'webp';
}
