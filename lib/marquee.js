/**
 * Drag-to-select (a marquee, as Finder draws it): the arithmetic, apart from
 * the pointer handling (app/components/ui/useMarquee.js) so it can be tested
 * without a DOM.
 *
 * Hits are worked out from the layout, not by asking the DOM which cards are
 * under the rectangle: the grid and the list are virtualized, so a card that
 * has scrolled out of the window is not in the DOM at all, and a marquee
 * dragged down past the edge of the screen must still take it.
 *
 * Every rectangle is { left, top, right, bottom } in one coordinate space —
 * the viewport, as getBoundingClientRect returns.
 */

/** The rectangle two corners span, whichever way the drag went. */
export function rectFrom(x0, y0, x1, y1) {
  return { left: Math.min(x0, x1), top: Math.min(y0, y1), right: Math.max(x0, x1), bottom: Math.max(y0, y1) };
}

/** Do two rectangles share any area? Touching edges count, as a marquee brushing a card's edge takes it. */
export function overlaps(a, b) {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

/**
 * Indices of grid cells under `rect`. `box` is the grid's own rectangle (its
 * top is row 0's top, however far it is scrolled); `cols` columns of equal
 * width with `gap` between, rows `pitch` apart (a card plus the gap below
 * it). The gaps belong to no card, so a marquee drawn in a gap takes nothing.
 */
export function gridHits({ rect, box, cols, pitch, gap = 0, count }) {
  if (!rect || !box || !(cols > 0) || !(pitch > 0) || !(count > 0)) return [];
  const colW = (box.right - box.left - gap * (cols - 1)) / cols;
  const cardH = pitch - gap;
  const rows = Math.ceil(count / cols);
  const first = Math.max(0, Math.floor((rect.top - box.top) / pitch));
  const last = Math.min(rows - 1, Math.floor((rect.bottom - box.top) / pitch));
  const out = [];
  for (let row = first; row <= last; row++) {
    const top = box.top + row * pitch;
    if (top > rect.bottom || top + cardH < rect.top) continue;
    for (let col = 0; col < cols; col++) {
      const left = box.left + col * (colW + gap);
      if (left > rect.right || left + colW < rect.left) continue;
      const i = row * cols + col;
      if (i < count) out.push(i);
    }
  }
  return out;
}

/** Indices of list rows under `rect`: full-width rows `pitch` apart, from `box.top`. */
export function listHits({ rect, box, pitch, count }) {
  if (!rect || !box || !(pitch > 0) || !(count > 0)) return [];
  if (rect.right < box.left || rect.left > box.right) return [];
  const first = Math.max(0, Math.floor((rect.top - box.top) / pitch));
  const last = Math.min(count - 1, Math.floor((rect.bottom - box.top) / pitch));
  const out = [];
  for (let i = first; i <= last; i++) out.push(i);
  return out;
}

/** Past this many pixels of movement a press is a drag, short of it a click. */
export const DRAG_THRESHOLD = 5;
export const movedPast = (dx, dy, threshold = DRAG_THRESHOLD) => Math.hypot(dx, dy) >= threshold;

/**
 * How far to scroll this frame while the pointer is held near the top or
 * bottom of the window — faster the closer it is to the edge, so a marquee
 * can reach files below the fold. Negative is up.
 */
export function edgeScroll(y, viewport, { edge = 56, max = 22 } = {}) {
  if (y < edge) return -Math.ceil(max * Math.min(1, (edge - y) / edge));
  if (y > viewport - edge) return Math.ceil(max * Math.min(1, (y - (viewport - edge)) / edge));
  return 0;
}
