// lib/drive-color.js — each drive's own colour, for the dot beside its name.
//
// Stable (the same drive is the same colour on every page, for everyone,
// for as long as it exists) and taken from the brand: every entry is one of
// the palette's custom properties or a mix of two, so a white-label palette
// colours its own drives and the dark scheme — which redefines those same
// properties — re-colours them for free. Nothing here names a colour.
//
// The library, All files, is the accent itself; a drive is never given it,
// or anything near it, so the two are never confused. Nor --danger: red
// reads as an error. The palette has four hues besides (magenta, cyan and
// the warning's amber, and the accent), so the rest are mixed between them
// in OKLCH, which walks round the hue wheel — cyan and amber meet at a
// green, where an sRGB mix would meet at grey.

export const LIBRARY_COLOR = 'var(--accent)';

export const DRIVE_COLORS = Object.freeze([
  'var(--accent-alt)',
  'var(--accent-cool)',
  'var(--warning)',
  'color-mix(in oklch, var(--accent-cool), var(--warning))',
  'color-mix(in oklch, var(--accent), var(--accent-alt))',
  'color-mix(in oklch, var(--accent-cool) 70%, var(--warning))',
  'color-mix(in oklch, var(--accent-cool) 30%, var(--warning))',
]);

/** FNV-1a over the id's UTF-16 units: cheap, and spreads short ids well. */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The CSS colour for a drive id; the library's for none. */
export function driveColor(id) {
  const s = String(id || '');
  if (!s) return LIBRARY_COLOR;
  return DRIVE_COLORS[hash(s) % DRIVE_COLORS.length];
}
