// lib/placeholder.js — a thumbnail's picture, tiny enough to ride in its row.
//
// A tile waits for its thumbnail: a request to the bucket, one of the few the
// browser makes to it at a time. Until it lands the tile was an empty box.
// Now every thumbnail comes with a copy of itself PLACEHOLDER_EDGE pixels on
// its long side — a hundred or so bytes of WebP (JPEG from a browser that
// cannot encode WebP) — kept in the row's metadata as a data URL. The listing
// that draws the grid already has it, so a tile shows its picture blurred the
// moment it is drawn, and sharpens when the thumbnail arrives. No request, no
// decoder of our own: an <img> and UIImage both read it as it is.
//
// It is one of the media keys (lib/media.js MEDIA_KEYS): the server's to fill
// in from what it has checked (placeholderFacts), never a metadata edit's,
// cleared with the rest when a file's contents are replaced — and when its
// thumbnail is (lib/db.js setFileThumbnail), since it is that picture's.
//
// Plain functions with no imports, shared by the server, the browser and the
// tests. Onyx for Mac and the iPhone app read and make the same thing.

/** How many pixels a placeholder is on its long side. */
export const PLACEHOLDER_EDGE = 24;

/** The quality it is encoded at, WebP or JPEG: it is only ever shown blurred. */
export const PLACEHOLDER_QUALITY = 0.5;

/**
 * The most a stored placeholder may be, as a data URL, once compacted
 * (compactPlaceholder). A 24-pixel WebP is two or three hundred characters;
 * a JPEG carries its tables, and is some six hundred. Past this it is not a
 * placeholder any more.
 */
export const PLACEHOLDER_MAX_CHARS = 1600;
// …and as sent, before the colour profile an encoder wrapped it in is taken
// off: a profile alone can be a few kilobytes.
const PLACEHOLDER_SENT_MAX_CHARS = 8192;

const PATTERN = /^data:image\/(webp|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;

/** The placeholder's size for a picture of `source` ({ width, height }): PLACEHOLDER_EDGE on the long side. Null without a size. */
export function placeholderSize(source) {
  const w = Number(source?.width);
  const h = Number(source?.height);
  if (!(w > 0) || !(h > 0)) return null;
  const scale = PLACEHOLDER_EDGE / Math.max(w, h);
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/**
 * A placeholder a client sends, kept only when it is one: a data URL of a
 * WebP or a JPEG — nothing else an <img> would run or fetch — whose bytes
 * start as that format's do. Compacted (compactPlaceholder) whoever made it,
 * and then within PLACEHOLDER_MAX_CHARS. The string to store, or null.
 */
export function placeholderFacts(sent) {
  if (typeof sent !== 'string' || sent.length > PLACEHOLDER_SENT_MAX_CHARS) return null;
  const input = compactPlaceholder(sent);
  if (input.length > PLACEHOLDER_MAX_CHARS) return null;
  const m = PATTERN.exec(input);
  if (!m) return null;
  let bytes;
  try {
    bytes = atob(m[2]);
  } catch {
    return null;
  }
  const at = (i) => bytes.charCodeAt(i);
  const webp = bytes.length >= 12 && bytes.slice(0, 4) === 'RIFF' && bytes.slice(8, 12) === 'WEBP';
  const jpeg = bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff;
  if (m[1] === 'webp' ? !webp : !jpeg) return null;
  return input;
}

const le32 = (n) => String.fromCharCode(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
const readLe32 = (b, i) => (b.charCodeAt(i) | (b.charCodeAt(i + 1) << 8) | (b.charCodeAt(i + 2) << 16) | (b.charCodeAt(i + 3) << 24)) >>> 0;

/**
 * A placeholder as a canvas encodes it, less what it does not need: a
 * browser's canvas WebP carries a colour profile several times the size of
 * the picture — Chrome's is 456 bytes beside some 150 of image — and its
 * JPEG the same in APP segments. What stays is the picture alone, drawn as
 * sRGB, as a browser draws any picture with no profile: a WebP in its simple
 * form (one VP8 or VP8L chunk), a JPEG without APP1–APP15. Anything this
 * does not recognise — a WebP with transparency, say — comes back as it was.
 */
export function compactPlaceholder(dataUrl) {
  const m = typeof dataUrl === 'string' ? PATTERN.exec(dataUrl) : null;
  if (!m) return dataUrl;
  let bytes;
  try { bytes = atob(m[2]); } catch { return dataUrl; }
  const out = m[1] === 'webp' ? simpleWebp(bytes) : bareJpeg(bytes);
  return out ? `data:image/${m[1]};base64,${btoa(out)}` : dataUrl;
}

function simpleWebp(b) {
  if (b.length < 20 || b.slice(0, 4) !== 'RIFF' || b.slice(8, 12) !== 'WEBP') return null;
  let image = null;
  for (let i = 12; i + 8 <= b.length;) {
    const id = b.slice(i, i + 4);
    const len = readLe32(b, i + 4);
    if (i + 8 + len > b.length) return null;
    if (id === 'ALPH' || id === 'ANIM' || id === 'ANMF') return null;
    if (id === 'VP8 ' || id === 'VP8L') {
      if (image) return null;
      image = { id, data: b.slice(i + 8, i + 8 + len) };
    }
    i += 8 + len + (len & 1);
  }
  if (!image) return null;
  const pad = image.data.length & 1 ? '\0' : '';
  const chunk = image.id + le32(image.data.length) + image.data + pad;
  return `RIFF${le32(4 + chunk.length)}WEBP${chunk}`;
}

function bareJpeg(b) {
  if (b.length < 4 || b.charCodeAt(0) !== 0xff || b.charCodeAt(1) !== 0xd8) return null;
  let out = b.slice(0, 2);
  let i = 2;
  while (i + 4 <= b.length) {
    if (b.charCodeAt(i) !== 0xff) return null;
    const marker = b.charCodeAt(i + 1);
    // The scan runs to the end of the file: from here, everything is kept.
    if (marker === 0xda) return out + b.slice(i);
    const len = (b.charCodeAt(i + 2) << 8) | b.charCodeAt(i + 3);
    if (len < 2 || i + 2 + len > b.length) return null;
    if (!(marker >= 0xe1 && marker <= 0xef)) out += b.slice(i, i + 2 + len);
    i += 2 + len;
  }
  return null;
}

