// lib/justify.js — the Tile layout's arithmetic: justified rows.
//
// Pictures sit side by side at one height per row, each as wide as its own
// aspect ratio makes it, and every full row is scaled to fill the width
// exactly — the way a photo library lays out a shoot, where a grid of equal
// boxes would crop every portrait and letterbox every panorama. Items keep
// reading order (left to right, then down), which is what the keyboard and
// Shift-click ranges walk; CSS columns would have run them down each column.
//
// Pure, so the layout, what a marquee touches and where an arrow goes are
// tested without a DOM (app/components/ui/TileGrid.js draws it).

// Beyond these a picture would be a sliver or a strip; it is boxed at the
// limit and shown whole inside the box.
export const MIN_ASPECT = 0.4;
export const MAX_ASPECT = 3.2;
// A box for something with no dimensions (a document, audio): the grid's.
export const DEFAULT_ASPECT = 4 / 3;

/** A file's width ÷ height, from what was recorded at upload, clamped. */
export function aspectOf(file) {
  const w = Number(file?.metadata?.width);
  const h = Number(file?.metadata?.height);
  const a = w > 0 && h > 0 ? w / h : DEFAULT_ASPECT;
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, a));
}

/**
 * Lay out `aspects` in rows `width` wide.
 *
 *   target   the height a row aims for; full rows come out near it
 *   gap      between pictures, and between rows
 *   caption  the height under each picture for its name (same for all)
 *
 * A row takes pictures until the next would push it past the width, then
 * keeps or leaves that one — whichever puts the row's height nearer the
 * target — and is scaled to fill the width exactly. The last row is not
 * stretched: a lone picture there stays at the target height.
 *
 * → { rows: [{ start, end, top, height }], boxes: [{ left, top, width, height }], height }
 * where a row's height and a box's are the picture's; the caption is below.
 */
export function justifyRows(aspects, { width, target, gap = 8, caption = 0 } = {}) {
  const list = (aspects || []).map((a) => (Number.isFinite(a) && a > 0 ? a : DEFAULT_ASPECT));
  const W = Math.max(1, Number(width) || 1);
  const H = Math.max(1, Number(target) || 1);
  const rows = [];
  const boxes = new Array(list.length);
  let top = 0;

  const place = (start, end, h, stretch) => {
    const n = end - start;
    let left = 0;
    const room = W - gap * (n - 1);
    for (let i = start; i < end; i++) {
      // The last box of a stretched row takes the rounding, so the right
      // edges line up to the pixel.
      const w = stretch && i === end - 1 ? Math.max(1, room - (left - gap * (i - start))) : Math.max(1, Math.round(list[i] * h));
      boxes[i] = { left, top, width: w, height: Math.round(h) };
      left += w + gap;
    }
    rows.push({ start, end, top, height: Math.round(h) });
    top += Math.round(h) + caption + gap;
  };

  let start = 0;
  let sum = 0;
  for (let i = 0; i < list.length; i++) {
    sum += list[i];
    const n = i - start + 1;
    const atTarget = sum * H + gap * (n - 1);
    if (atTarget < W) continue;
    // Full. With this picture the row is at most the target height; without
    // it, at least. Keep whichever is nearer — never an empty row.
    const withH = (W - gap * (n - 1)) / sum;
    const withoutSum = sum - list[i];
    const withoutH = n > 1 ? (W - gap * (n - 2)) / withoutSum : Infinity;
    if (n > 1 && Math.abs(withoutH - H) < Math.abs(withH - H)) {
      place(start, i, withoutH, true);
      start = i;
      sum = list[i];
    } else {
      place(start, i + 1, withH, true);
      start = i + 1;
      sum = 0;
    }
  }
  if (start < list.length) {
    // The last row, unstretched — unless even at the target it overflows,
    // which a single very wide picture on a phone can.
    const n = list.length - start;
    const natural = sum * H + gap * (n - 1);
    place(start, list.length, natural > W ? (W - gap * (n - 1)) / sum : H, natural > W);
  }
  return { rows, boxes, height: Math.max(0, top - gap) };
}

/** The rows that intersect [from, to] (px from the layout's top), with `overscan` more each side. */
export function rowsInView(layout, from, to, { overscan = 0, caption = 0 } = {}) {
  const rows = layout?.rows || [];
  if (!rows.length) return { start: 0, end: 0 };
  // Rows are in order and do not overlap: the first whose bottom reaches `from`.
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].top + rows[mid].height + caption < from) lo = mid + 1;
    else hi = mid;
  }
  let end = lo;
  while (end < rows.length && rows[end].top <= to) end++;
  return { start: Math.max(0, lo - overscan), end: Math.min(rows.length, Math.max(end, lo + 1) + overscan) };
}

/**
 * Indices of the tiles under `rect` (viewport coordinates); `box` is the
 * layout's own rectangle, as getBoundingClientRect gives it. A tile is its
 * picture and its caption; the gaps belong to nobody.
 */
export function tileHits({ rect, box, layout, caption = 0 }) {
  if (!rect || !box || !layout) return [];
  const x0 = rect.left - box.left;
  const x1 = rect.right - box.left;
  const y0 = rect.top - box.top;
  const y1 = rect.bottom - box.top;
  const out = [];
  for (const row of layout.rows) {
    if (row.top > y1) break;
    if (row.top + row.height + caption < y0) continue;
    for (let i = row.start; i < row.end; i++) {
      const b = layout.boxes[i];
      if (b.left <= x1 && b.left + b.width >= x0) out.push(i);
    }
  }
  return out;
}

/** Which row tile `i` is in. */
function rowOf(layout, i) {
  const rows = layout.rows;
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rows[mid].start <= i) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Where ↑ or ↓ goes from tile `i`: the tile in the row above or below
 * whose span is nearest the middle of this one. Off the top it says so —
 * { cross: 'up', x } with x the middle as a fraction of the width — for the
 * page to carry on into the folders above; off the bottom, null.
 */
export function tileStep(layout, i, key, { width } = {}) {
  if (!layout?.rows?.length || !layout.boxes[i]) return null;
  const r = rowOf(layout, i);
  const b = layout.boxes[i];
  const mid = b.left + b.width / 2;
  const to = key === 'ArrowUp' ? r - 1 : key === 'ArrowDown' ? r + 1 : null;
  if (to == null) return null;
  if (to < 0) return { cross: 'up', x: width ? Math.min(1, Math.max(0, mid / width)) : 0 };
  if (to >= layout.rows.length) return null;
  const row = layout.rows[to];
  let best = row.start;
  let bestD = Infinity;
  for (let j = row.start; j < row.end; j++) {
    const c = layout.boxes[j];
    const d = mid < c.left ? c.left - mid : mid > c.left + c.width ? mid - (c.left + c.width) : 0;
    if (d < bestD) { best = j; bestD = d; }
  }
  return best;
}
