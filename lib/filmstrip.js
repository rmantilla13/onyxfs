// lib/filmstrip.js — the geometry of a hover-scrub sprite sheet.
//
// A filmstrip is N frames of a video tiled into one image, made in the browser
// at upload. Hovering the scrub bar shows the frame under the cursor without
// touching the master: one small request, cached by the browser, instead of a
// range request into a multi-gigabyte file for every pixel of pointer travel.
//
// Pure functions, no imports. Shared by the generator (deciding the sheet's
// dimensions) and the player (deciding which tile to show).

/** Frames in a sheet. 40 is dense enough that a 2-minute clip lands within 3 seconds per frame. */
export const FILMSTRIP_FRAMES = 40;
/** Tile width, in CSS pixels: what the player shows under the pointer. Height follows the source aspect ratio. */
export const FILMSTRIP_TILE_WIDTH = 160;
/** Tiles per row. A single row of 40 would be 6400px wide — past the 4096px texture limit some mobile GPUs impose, which makes the whole sheet fail to decode. */
export const FILMSTRIP_COLUMNS = 8;
/**
 * Image pixels per CSS pixel in a sheet made today. At 1 a 160px tile was
 * enlarged 2x on a 2x screen, which is every Mac: soft to the point of mush.
 * The geometry stored with a row stays in CSS pixels and the player sets
 * `background-size` in them, so a 2x sheet needs nothing from the player —
 * the browser fits the image to that size — and a sheet from before this
 * (1x) still lines up exactly.
 */
export const FILMSTRIP_DENSITY = 2;
/** The largest sheet a browser is asked to decode, in image pixels. */
export const FILMSTRIP_MAX_SHEET = 4096;

/**
 * Sheet dimensions for a source of `width`x`height`.
 *
 * Returns null when the source has no usable dimensions — a caller should skip
 * the filmstrip rather than encode a 0x0 canvas, which throws in some browsers
 * and yields a blank image in others.
 *
 * `density` asks for a sheet encoded at that many image pixels per CSS pixel.
 * The layout says what it got (`density`, and the image size as
 * `pixelWidth` x `pixelHeight`): 1 when the source is not wide enough to fill
 * a denser tile without enlarging it, or when the denser sheet would pass
 * FILMSTRIP_MAX_SHEET (a very tall clip). Every other field is CSS pixels.
 */
export function filmstripLayout({ width, height, frames = FILMSTRIP_FRAMES, columns = FILMSTRIP_COLUMNS, tileWidth = FILMSTRIP_TILE_WIDTH, density = 1 } = {}) {
  const w = Number(width);
  const h = Number(height);
  const count = Math.max(1, Math.floor(Number(frames) || 0));
  const cols = Math.max(1, Math.floor(Number(columns) || 0));
  const tw = Math.max(1, Math.round(Number(tileWidth) || 0));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;

  // Round the tile height to an even number: an odd height makes the sprite
  // offsets land on half pixels at some zoom levels, and the tile shows a
  // sliver of its neighbour.
  const tileHeight = Math.max(2, Math.round((h / w) * tw / 2) * 2);
  const rows = Math.ceil(count / cols);
  const sheetWidth = cols * tw;
  const sheetHeight = rows * tileHeight;
  let d = Math.max(1, Math.floor(Number(density) || 1));
  while (d > 1 && (tw * d > w || Math.max(sheetWidth, sheetHeight) * d > FILMSTRIP_MAX_SHEET)) d -= 1;
  return {
    frames: count,
    columns: cols,
    rows,
    tileWidth: tw,
    tileHeight,
    sheetWidth,
    sheetHeight,
    density: d,
    pixelWidth: sheetWidth * d,
    pixelHeight: sheetHeight * d,
  };
}

/**
 * The timestamps to capture, spread across the clip.
 *
 * Offset half a step in rather than starting at 0: the first frame of a video
 * is very often black or a slate, and a strip whose first tile is black looks
 * broken. The last is pulled back off the final frame for the same reason.
 */
export function filmstripTimes(duration, frames = FILMSTRIP_FRAMES) {
  const total = Number(duration);
  const count = Math.max(1, Math.floor(Number(frames) || 0));
  if (!Number.isFinite(total) || total <= 0) return [];
  const step = total / count;
  return Array.from({ length: count }, (_, i) => Math.min(total, (i + 0.5) * step));
}

/** Which tile represents `time`. */
export function frameIndexAt(time, duration, frames = FILMSTRIP_FRAMES) {
  const total = Number(duration);
  const count = Math.max(1, Math.floor(Number(frames) || 0));
  if (!Number.isFinite(total) || total <= 0) return 0;
  const t = Math.min(Math.max(0, Number(time) || 0), total);
  // `count - 1` as the ceiling, not `count`: at exactly `duration` the ratio is
  // 1 and `1 * count` indexes one tile past the end, which renders as empty
  // space at the right-hand edge of the bar — precisely where a scrub ends.
  return Math.min(count - 1, Math.floor((t / total) * count));
}

/**
 * CSS for showing tile `index` of a sheet, as a style object.
 *
 * `backgroundSize` is given in pixels rather than as a percentage: a percentage
 * background-size on a sprite resolves against the element box, so the tile
 * rescales whenever the preview box changes and the offsets stop lining up.
 */
export function framePosition(index, layout) {
  if (!layout) return null;
  const i = Math.min(Math.max(0, Math.floor(Number(index) || 0)), layout.frames - 1);
  const col = i % layout.columns;
  const row = Math.floor(i / layout.columns);
  return {
    width: `${layout.tileWidth}px`,
    height: `${layout.tileHeight}px`,
    backgroundSize: `${layout.sheetWidth}px ${layout.sheetHeight}px`,
    backgroundPosition: `-${col * layout.tileWidth}px -${row * layout.tileHeight}px`,
    backgroundRepeat: 'no-repeat',
  };
}

/** Recover the layout from what was stored with the row, so the player does not have to guess. */
export function layoutFromMetadata(metadata) {
  const strip = metadata?.filmstrip;
  if (!strip) return null;
  const layout = filmstripLayout({
    width: strip.tileWidth, height: strip.tileHeight,
    frames: strip.frames, columns: strip.columns, tileWidth: strip.tileWidth,
  });
  // filmstripLayout recomputes tileHeight from the aspect ratio; the stored
  // value is authoritative, because it is what the sheet was actually encoded
  // at and a rounding difference here shifts every tile.
  if (!layout) return null;
  // The stored geometry is CSS pixels whatever the sheet's density, and the
  // player needs nothing else; the image-pixel fields would only mislead.
  const { density, pixelWidth, pixelHeight, ...css } = layout;
  return { ...css, tileHeight: Number(strip.tileHeight) || layout.tileHeight,
           sheetHeight: layout.rows * (Number(strip.tileHeight) || layout.tileHeight) };
}
