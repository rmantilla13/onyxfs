// lib/menu-place.js — where a popup menu goes so it stays on screen.
//
// Pure arithmetic, kept out of the component so it is testable without a DOM.

/**
 * Where a menu of size w×h opened at (x, y) should go so all of it is on
 * screen: flipped left/up when it would run off the right/bottom edge, then
 * clamped to a margin. Pure, so the edge cases are testable without a DOM.
 * `anchor` (a rect) is for keyboard opening — the menu goes below the
 * element, or above it when there is no room below.
 */
export function placeMenu({ x, y, w, h, vw, vh, margin = 8, anchor = null }) {
  let left = x;
  let top = y;
  if (anchor) {
    left = anchor.left;
    top = anchor.bottom + 2;
    if (top + h > vh - margin && anchor.top - h - 2 >= margin) top = anchor.top - h - 2;
  } else {
    if (left + w > vw - margin) left = x - w;
    if (top + h > vh - margin) top = y - h;
  }
  left = Math.min(Math.max(margin, left), Math.max(margin, vw - w - margin));
  top = Math.min(Math.max(margin, top), Math.max(margin, vh - h - margin));
  return { left: Math.round(left), top: Math.round(top) };
}
