// lib/virtual-rows.js — which rows of a virtualized list are worth rendering.
//
// Pure arithmetic so it can be tested without a DOM. `top` is the list's top
// edge relative to the viewport (negative once scrolled past), `pitch` one
// row's height including the gap below it.

//
// `before` and `after` (rows above and below the viewport) default to
// `overscan` each. A list being scrolled wants more of them on the side it is
// heading to: rows mounted there early have their pictures loaded and decoded
// before they come into view, rather than while they do.
export function rowWindow({ top, viewport, pitch, rowCount, overscan = 0, before = overscan, after = overscan }) {
  if (!(pitch > 0) || !(rowCount > 0)) return { start: 0, end: 0 };
  const start = Math.min(rowCount, Math.max(0, Math.floor(-top / pitch) - before));
  const end = Math.min(rowCount, Math.ceil((viewport - top) / pitch) + after);
  return { start, end: Math.max(start, end) };
}

/**
 * Overscan split by the direction of the last scroll (+1 down, -1 up, 0 at
 * rest): at rest `overscan` each side; moving, most of `total` ahead and one
 * row behind — the same number of rows mounted, placed where they are about
 * to be needed.
 */
export function overscanFor(direction, { overscan = 4, total = overscan * 2, behind = 1 } = {}) {
  if (!direction) return { before: overscan, after: overscan };
  const ahead = Math.max(overscan, total - behind);
  return direction > 0 ? { before: behind, after: ahead } : { before: ahead, after: behind };
}

/**
 * How many items of a grid a screen shows before it is scrolled: every item
 * in each row that is at least partly in view, when the grid's top edge is
 * `top` px down the page — never less than one row. The pictures of these
 * are asked for at once and first (FileGrid's `eager`); the rest as they
 * near the viewport. 0 before the layout is known.
 */
export function firstScreenCount({ cols, pitch, top = 0, viewport }) {
  if (!(cols > 0) || !(pitch > 0) || !(viewport > 0)) return 0;
  return cols * Math.max(1, Math.ceil((viewport - Math.max(0, top)) / pitch));
}
