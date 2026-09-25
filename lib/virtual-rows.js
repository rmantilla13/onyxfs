// lib/virtual-rows.js — which rows of a virtualized list are worth rendering.
//
// Pure arithmetic so it can be tested without a DOM. `top` is the list's top
// edge relative to the viewport (negative once scrolled past), `pitch` one
// row's height including the gap below it.

export function rowWindow({ top, viewport, pitch, rowCount, overscan = 0 }) {
  if (!(pitch > 0) || !(rowCount > 0)) return { start: 0, end: 0 };
  const start = Math.min(rowCount, Math.max(0, Math.floor(-top / pitch) - overscan));
  const end = Math.min(rowCount, Math.ceil((viewport - top) / pitch) + overscan);
  return { start, end: Math.max(start, end) };
}
