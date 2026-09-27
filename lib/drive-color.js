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

// ── The same colour as #RRGGBB ──────────────────────────────────────────────
//
// For a client with no stylesheet to resolve the brand's properties in: the
// Mac, which paints each drive's disk icon in Finder in its colour. An entry
// is resolved against the palette as the browser resolves it — a property is
// the palette's colour, a mix is made in OKLCH, the shorter way round the hue
// wheel — and a mix that lands outside sRGB is brought in as CSS Color 4 maps
// one, by lowering its chroma and keeping its lightness and hue. So the dot
// beside a drive's name and the icon of its disk are one colour.

const VAR = /^var\(--([a-z-]+)\)$/;
const MIX = /^color-mix\(in oklch, var\(--([a-z-]+)\)(?: (\d+)%)?, var\(--([a-z-]+)\)(?: (\d+)%)?\)$/;

/** `accent-cool` → the palette's `accentCool`. */
const paletteKey = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const hexOf = (v) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? v.toUpperCase() : null);

/**
 * A drive's colour as #RRGGBB for `palette` — the resolved brand's
 * (loadBrand().visual.palette), the colours the brand chose rather than the
 * dark scheme's lifts of them. The library's for no id. Null only for a
 * palette that lacks a colour the table names.
 */
export function driveColorHex(id, palette) {
  const css = driveColor(id);
  const own = VAR.exec(css);
  if (own) return hexOf(palette?.[paletteKey(own[1])]);
  const mix = MIX.exec(css);
  if (!mix) return null;
  const [, a, pa, b, pb] = mix;
  const [x, y] = [hexOf(palette?.[paletteKey(a)]), hexOf(palette?.[paletteKey(b)])];
  if (!x || !y) return null;
  // CSS Color 5: a share left out is what the other leaves, and with
  // neither given they are even.
  const p = pa != null ? Number(pa) : pb != null ? 100 - Number(pb) : 50;
  const q = pb != null ? Number(pb) : 100 - p;
  return mixOklch(x, y, p + q > 0 ? p / (p + q) : 0.5);
}

/** `t` of x and the rest of y, mixed in OKLCH, as #RRGGBB. Exported for tests. */
export function mixOklch(x, y, t) {
  const [L1, C1, h1] = lch(oklab(rgb(x)));
  const [L2, C2, h2] = lch(oklab(rgb(y)));
  // A grey has no hue to speak of (CSS calls it powerless): it takes the
  // other colour's.
  const H1 = C1 < 1e-4 ? h2 : h1;
  const H2 = C2 < 1e-4 ? H1 : h2;
  let turn = H2 - H1;
  if (turn > Math.PI) turn -= 2 * Math.PI;
  else if (turn < -Math.PI) turn += 2 * Math.PI;
  const mixed = [L1 * t + L2 * (1 - t), C1 * t + C2 * (1 - t), H1 + turn * (1 - t)];
  return `#${inGamut(mixed).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

// sRGB's transfer function, either way, keeping the sign: a colour outside
// the gamut has channels below 0 or above 1, and must still be seen to.
const linear = (v) => Math.sign(v) * (Math.abs(v) <= 0.04045 ? Math.abs(v) / 12.92 : ((Math.abs(v) + 0.055) / 1.055) ** 2.4);
const gamma = (v) => Math.sign(v) * (Math.abs(v) <= 0.0031308 ? 12.92 * Math.abs(v) : 1.055 * Math.abs(v) ** (1 / 2.4) - 0.055);

/** sRGB, 0…1 a channel → OKLab (Björn Ottosson's matrices, as CSS Color 4 has them). */
function oklab(c) {
  const [r, g, b] = c.map(linear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab → sRGB, 0…1 a channel, not yet brought into gamut. */
function srgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(gamma);
}

const lch = ([L, a, b]) => [L, Math.hypot(a, b), Math.atan2(b, a)];
const lab = ([L, C, h]) => [L, C * Math.cos(h), C * Math.sin(h)];

/**
 * An OKLCH colour as sRGB: itself when sRGB has it, else CSS Color 4's gamut
 * mapping — the chroma searched down until clipping what is left moves the
 * colour less than one just-noticeable difference.
 */
function inGamut([L, C, h]) {
  if (L >= 1) return [1, 1, 1];
  if (L <= 0) return [0, 0, 0];
  const JND = 0.02;
  const EPSILON = 0.0001;
  const at = (chroma) => srgb(lab([L, chroma, h]));
  const inside = (c) => c.every((v) => v >= -EPSILON && v <= 1 + EPSILON);
  const clip = (c) => c.map((v) => Math.min(1, Math.max(0, v)));
  const moved = (c, chroma) => {
    const [p, q] = [oklab(c), lab([L, chroma, h])];
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  };
  let current = at(C);
  if (inside(current)) return clip(current);
  let clipped = clip(current);
  if (moved(clipped, C) < JND) return clipped;
  let [min, max, minInside] = [0, C, true];
  while (max - min > EPSILON) {
    const chroma = (min + max) / 2;
    current = at(chroma);
    if (minInside && inside(current)) {
      min = chroma;
      continue;
    }
    clipped = clip(current);
    const e = moved(clipped, chroma);
    if (e < JND) {
      if (JND - e < EPSILON) break;
      minInside = false;
      min = chroma;
    } else {
      max = chroma;
    }
  }
  return clipped;
}
