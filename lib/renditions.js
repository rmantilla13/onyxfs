// lib/renditions.js — which stored picture each surface shows.
//
// A file can have up to four pictures besides its original (lib/poster.js):
// the grid poster (`thumbnailUrl`), its smaller siblings `smUrl` and `xsUrl`
// (when `thumbSizes` lists them), and a large preview (`posterUrl`: a
// video's player poster, or an image's ≤2400px preview). Each surface asks
// here for the smallest one that looks sharp on it, using the same size
// functions the generator drew them with, so the two can never disagree.
//
//   card     srcset of sm and grid, `sizes` the measured column width
//   row      xs (list rows, 44/40 CSS px)
//   palette  xs (⌘K results, 28 CSS px)
//   storage  xs (the storage pages, 56 CSS px)
//   info     sm (Get info, 72 CSS px)
//   stage    { thumb, preview, original }: the layers a viewer loads in turn
//
// And where those pictures come from (pictureOrigins), for a page to
// connect to before it asks for them.
//
// Pure: a URL that failed to load in this tile is passed back in `failed`,
// and the answer skips it — a dead sibling falls back to the grid poster,
// a dead poster to a small original, then to the typed placeholder.

import { drawableKind, GRID_ORIGINAL_MAX_BYTES } from './media.js';
import { gridPosterSize, smPosterSize, coverWidth } from './poster.js';

/** A small original stands in on a list row or in the palette only up to this. */
export const ROW_ORIGINAL_MAX_BYTES = 1024 * 1024;

/**
 * Before the grid is measured (the server render): its columns, as `sizes`.
 * On a phone a column is half the width less the page's padding and the gap
 * (calc(50vw - 32px): 163px on a 390px screen) — plain 50vw asked a 3x phone
 * for 585 device pixels, which picked the grid poster over sm, and a browser
 * does not trade a larger picture it has for a smaller one once measured.
 */
export const CARD_SIZES_DEFAULT = '(max-width: 719px) calc(50vw - 32px), 240px';

const SURFACE_ORIGINAL_MAX = {
  card: GRID_ORIGINAL_MAX_BYTES,
  info: GRID_ORIGINAL_MAX_BYTES,
  row: ROW_ORIGINAL_MAX_BYTES,
  palette: ROW_ORIGINAL_MAX_BYTES,
  storage: ROW_ORIGINAL_MAX_BYTES,
};

function sourceDims(file) {
  const w = Number(file?.metadata?.width);
  const h = Number(file?.metadata?.height);
  return w > 0 && h > 0 ? { width: w, height: h } : null;
}

const has = (file, size) => Array.isArray(file?.thumbSizes) && file.thumbSizes.includes(size);

/**
 * The original, when it may stand in for a missing preview on `surface`: an
 * image a browser draws, and small. A video never — its original is not a
 * picture an <img> can show.
 */
export function smallOriginal(file, surface = 'card') {
  if (!file?.url || drawableKind(file) !== 'image') return null;
  const max = SURFACE_ORIGINAL_MAX[surface] ?? GRID_ORIGINAL_MAX_BYTES;
  return Number(file.size || 0) <= max ? file.url : null;
}

/**
 * `{ src, srcSet?, sizes? }` for `surface`, or `{ src: null }` for the
 * placeholder. `sizes` is the card's measured width in CSS px (a number) or
 * a sizes string; without one, CARD_SIZES_DEFAULT.
 */
export function thumbSources(file, surface = 'card', { sizes, failed } = {}) {
  const ok = (u) => !!u && !failed?.has?.(u);
  const grid = ok(file?.thumbnailUrl) ? file.thumbnailUrl : null;
  const sm = has(file, 'sm') && ok(file?.smUrl) ? file.smUrl : null;
  const xs = has(file, 'xs') && ok(file?.xsUrl) ? file.xsUrl : null;
  const original = ok(smallOriginal(file, surface)) ? smallOriginal(file, surface) : null;

  if (surface === 'row' || surface === 'palette' || surface === 'storage') {
    return { src: xs || sm || grid || original || null };
  }
  if (surface === 'info') return { src: sm || grid || original || null };

  // card
  if (!grid) return { src: sm || original || null };
  const dims = sourceDims(file);
  if (!sm || !dims) return { src: grid };
  const gw = coverWidth(gridPosterSize(dims));
  const sw = coverWidth(smPosterSize(dims));
  // Nothing to choose between when the two cover the same card.
  if (!(sw > 0) || !(gw > sw)) return { src: grid };
  return {
    src: grid,
    srcSet: `${sm} ${sw}w, ${grid} ${gw}w`,
    sizes: typeof sizes === 'number' && sizes > 0 ? `${Math.round(sizes)}px` : (typeof sizes === 'string' && sizes) || CARD_SIZES_DEFAULT,
  };
}

/**
 * Where the pictures at `urls` come from: their origins, the most used
 * first, at most `max`. A page connects to these before it asks for anything
 * (app/components/PreviewPreconnect.js). Only an http(s) origin ever comes
 * out — never a path, never a query, which on a signed URL is its signature.
 */
export function pictureOrigins(urls, { max = 2 } = {}) {
  const counts = new Map();
  for (const url of Array.isArray(urls) ? urls : []) {
    if (typeof url !== 'string' || !url) continue;
    let u;
    try { u = new URL(url); } catch { continue; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    counts.set(u.origin, (counts.get(u.origin) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, Math.max(0, max)).map(([origin]) => origin);
}

// The viewers' layers live on their own (lib/stage-sources.js) so the file
// page does not pull in the grid's size arithmetic to read three URLs.
export { stageSources } from './stage-sources.js';
