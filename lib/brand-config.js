// lib/brand-config.js — the white-label layer.
//
// Onyx ships with itself as the default brand (everything in lib/brand.js →
// BRAND). To run this platform under a DIFFERENT name, an admin fills in the
// "Brand" tab in /admin. Those values are stored as one flat object in the
// settings table under 'brand.config' and layered OVER the Onyx defaults at
// runtime by resolveBrand() — so any field left blank falls back to the
// default, and a fresh install behaves exactly as if this layer did not exist.
//
// The rule that makes this work: NOTHING in the app imports BRAND directly to
// render user-facing text. Everything goes through resolveBrand(), so
// re-branding is a settings write, not a redeploy.
//
// The one deliberate exception is the desktop URL scheme. It is compiled into
// the app bundle and registered with the OS at install time, so it cannot be
// changed from a settings row — resolveBrand() reports it but sanitizeBrand()
// marks it read-only for the admin form.

import React from 'react';
import { BRAND } from './brand.js';

// React is CommonJS, so a named `import { cache }` cannot be resolved when
// this module is loaded outside Next's bundler — which the tests do. The
// default import works either way, and the fallback keeps loadBrand callable
// from a plain Node process where there is no request to scope a cache to.
const cache = React.cache || ((fn) => fn);
import { getBrandConfig } from './db.js';

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const hex = (v) => (/^#[0-9a-fA-F]{6}$/.test(String(v || '').trim()) ? String(v).trim() : undefined);

/**
 * The Onyx defaults, flattened to the same shape the admin form edits. The API
 * returns this alongside the saved config so the form can show each default as
 * a placeholder rather than an empty box.
 */
export function defaultBrandConfig() {
  const p = BRAND.visual.palette;
  return {
    // Identity
    name: BRAND.name,
    tagline: BRAND.tagline,
    description: BRAND.description,

    // Links
    origin: BRAND.origin,
    supportEmail: BRAND.supportEmail,

    // Palette
    colorPaper: p.paper,
    colorInk: p.ink,
    colorMuted: p.muted,
    colorLine: p.line,
    colorAccent: p.accent,
    colorAccentDeep: p.accentDeep,
    colorAccentAlt: p.accentAlt,
    colorAccentCool: p.accentCool,

    // Type
    displayFontFamily: BRAND.visual.fonts.display.family,
    displayFontUrl: BRAND.visual.fonts.display.url || '',
    bodyFontFamily: BRAND.visual.fonts.body.family,
    bodyFontUrl: BRAND.visual.fonts.body.url || '',

    // Marks
    markUrl: BRAND.visual.logo.markPath,
    lockupUrl: BRAND.visual.logo.lockupPath,
    radius: BRAND.visual.radius,

    // Desktop (read-only in the form — see the note at the top)
    desktopProductName: BRAND.desktop.productName,
    desktopScheme: BRAND.desktop.scheme,
    mountFolder: BRAND.desktop.mountFolder,
  };
}

/**
 * Layer a saved config over the defaults and return a full BRAND-shaped object.
 * Pure — pass the saved blob in. Use loadBrand() when you want it fetched.
 */
export function resolveBrand(saved) {
  const c = saved && typeof saved === 'object' ? saved : {};
  const d = BRAND;
  const p = d.visual.palette;
  return {
    name: str(c.name) || d.name,
    tagline: str(c.tagline) || d.tagline,
    description: str(c.description) || d.description,
    origin: (str(c.origin) || process.env.NEXT_PUBLIC_APP_URL || d.origin).replace(/\/$/, ''),
    supportEmail: str(c.supportEmail) || d.supportEmail,
    visual: {
      palette: {
        paper: hex(c.colorPaper) || p.paper,
        ink: hex(c.colorInk) || p.ink,
        muted: hex(c.colorMuted) || p.muted,
        line: hex(c.colorLine) || p.line,
        accent: hex(c.colorAccent) || p.accent,
        accentDeep: hex(c.colorAccentDeep) || p.accentDeep,
        accentAlt: hex(c.colorAccentAlt) || p.accentAlt,
        accentCool: hex(c.colorAccentCool) || p.accentCool,
        warning: hex(c.colorWarning) || p.warning,
        danger: hex(c.colorDanger) || p.danger,
      },
      fonts: {
        display: {
          family: str(c.displayFontFamily) || d.visual.fonts.display.family,
          url: str(c.displayFontUrl) || d.visual.fonts.display.url,
        },
        body: {
          family: str(c.bodyFontFamily) || d.visual.fonts.body.family,
          url: str(c.bodyFontUrl) || d.visual.fonts.body.url,
        },
        mono: { ...d.visual.fonts.mono },
      },
      logo: {
        markPath: str(c.markUrl) || d.visual.logo.markPath,
        lockupPath: str(c.lockupUrl) || d.visual.logo.lockupPath,
      },
      radius: str(c.radius) || d.visual.radius,
    },
    desktop: {
      productName: str(c.desktopProductName) || d.desktop.productName,
      // Compiled into the bundle — never read from the saved config.
      scheme: d.desktop.scheme,
      identifier: d.desktop.identifier,
      updateRepo: d.desktop.updateRepo,
      mountFolder: str(c.mountFolder) || d.desktop.mountFolder,
    },
  };
}

/**
 * Fetch + resolve. The one call almost every server component wants.
 *
 * Wrapped in React's per-request cache: the root layout's generateMetadata,
 * the layout itself and the page each call this, and without the cache that
 * was three settings reads per render, issued concurrently against a
 * one-connection pool. Outside a React request (auth.js's email sender) the
 * cache is a no-op and this is a plain call.
 */
export const loadBrand = cache(async function loadBrand() {
  try {
    return resolveBrand(await getBrandConfig());
  } catch {
    // A settings read failure must never blank the app's name.
    return resolveBrand(null);
  }
});

/**
 * A CSS value safe to inline inside a <style> element.
 *
 * Two different hazards, one function. Colors are already hex-validated by
 * resolveBrand, but font families and the radius are free text an admin
 * typed, and they are written into a raw <style> whose contents the browser
 * does NOT HTML-decode. So a value carrying `</style>` would close the
 * element and anything after it would be parsed as markup. Characters that
 * can end a declaration or the element are dropped rather than escaped,
 * because escaping inside a style element does not work — that is the same
 * mistake that broke the font stack (see app/layout.js).
 */
const cssValue = (v) => String(v ?? '').replace(/[<>{};\\]/g, '').trim();

/**
 * The resolved brand as CSS custom properties, for the root layout to inline
 * on both :root and ::backdrop.
 * Every color and font in the app reads from these, so a brand change repaints
 * without touching a stylesheet.
 */
export function brandCssVars(brand) {
  const f = brand.visual.fonts;
  return [
    paletteCssVars(brand.visual.palette),
    auraCssVars(brand.visual.palette),
    `--font-display:${cssValue(f.display.family)}`,
    `--font-body:${cssValue(f.body.family)}`,
    `--font-mono:${cssValue(f.mono.family)}`,
    `--radius:${cssValue(brand.visual.radius)}`,
  ].join(';');
}

/**
 * The dark scheme's colours, for the root layout to inline under
 * [data-theme='dark']. Colours only — fonts and radius do not change with
 * the scheme, so the light block's declarations still apply.
 */
export function brandDarkCssVars(brand) {
  return paletteCssVars(darkPalette(brand.visual.palette));
}

function paletteCssVars(p) {
  return [
    `--paper:${cssValue(p.paper)}`,
    `--ink:${cssValue(p.ink)}`,
    `--muted:${cssValue(p.muted)}`,
    `--line:${cssValue(p.line)}`,
    `--accent:${cssValue(p.accent)}`,
    `--accent-deep:${cssValue(p.accentDeep)}`,
    `--accent-alt:${cssValue(p.accentAlt)}`,
    `--accent-cool:${cssValue(p.accentCool)}`,
    `--warning:${cssValue(p.warning)}`,
    `--danger:${cssValue(p.danger)}`,
  ].join(';');
}

/**
 * The aura: the brand's accents at full strength, for the glows behind the
 * page and the gradients on buttons and badges. Emitted on :root only, so the
 * dark scheme — which lifts --accent* for legibility as TEXT — keeps these
 * saturated: a glow wants the hue, not the lifted tint.
 *
 * `--on-aura` is the label colour for a filled gradient (white, unless the
 * brand's accent is too light for it), and `--aura-b-deep` is the second hue
 * darkened just far enough to carry that label at AA — a neon magenta cannot.
 */
export function auraCssVars(p) {
  const white = '#FFFFFF';
  const onAura = contrast(white, p.accent) >= contrast(p.ink, p.accent) ? white : p.ink;
  const deepen = (c) => {
    for (let t = 0; t <= 1; t += 0.05) {
      const d = mixHex(c, onAura === white ? '#000000' : white, t);
      if (contrast(d, onAura) >= 4.5) return d;
    }
    return c;
  };
  return [
    `--aura-a:${cssValue(p.accent)}`,
    `--aura-b:${cssValue(p.accentAlt)}`,
    `--aura-c:${cssValue(p.accentCool)}`,
    `--aura-a-deep:${cssValue(deepen(p.accent))}`,
    `--aura-b-deep:${cssValue(deepen(p.accentAlt))}`,
    `--on-aura:${cssValue(onAura)}`,
  ].join(';');
}

// ── Dark scheme ─────────────────────────────────────────────────────────────
//
// Derived from the brand palette rather than configured beside it, so a
// white-label brand gets a dark mode without an admin filling in a second
// set of eight colours. The brand's ink becomes the page and its paper the
// text; every colour that is ever used as text is then lifted toward the
// text colour until it clears WCAG AA (4.5:1) on the lightest surface it
// sits on, tints included. That keeps the brand's hue and only changes
// lightness as much as legibility needs.

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
/** a with t of b mixed in, in sRGB — the same maths as CSS color-mix(in srgb). */
export const mixHex = (a, b, t) => toHex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));

function luminance(h) {
  const [r, g, b] = rgb(h).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Mix fg toward `toward` in 5% steps until it reaches `min` against bg, and
 * against bg with 14% of itself mixed in — the .tag-* chips, where a colour
 * is its own text on a tint of itself.
 */
function legible(fg, bg, toward, min = 4.5) {
  for (let t = 0; t <= 1; t += 0.05) {
    const c = mixHex(fg, toward, t);
    if (contrast(c, bg) >= min && contrast(c, mixHex(bg, c, 0.14)) >= min) return c;
  }
  return toward;
}

/**
 * The dark palette for a (light) brand palette. Pure; exported for tests.
 *
 * A brand whose paper is already darker than its ink is a dark brand, and is
 * returned as-is: flipping it would give that deployment a light "dark mode".
 */
export function darkPalette(p) {
  if (luminance(p.paper) < luminance(p.ink)) return { ...p };
  const paper = p.ink;
  const ink = mixHex(p.paper, p.ink, 0.08);
  // The card colour from globals.css (--surface), which is the lightest
  // background text sits on in the dark scheme, so the one to test against.
  const surface = mixHex(paper, '#ffffff', 0.08);
  const lift = (c) => legible(c, surface, ink);
  return {
    paper,
    ink,
    muted: lift(p.muted),
    line: mixHex(paper, ink, 0.16),
    accent: lift(p.accent),
    accentDeep: lift(p.accentDeep),
    accentAlt: lift(p.accentAlt),
    accentCool: lift(p.accentCool),
    warning: lift(p.warning),
    danger: lift(p.danger),
  };
}

/**
 * Which fields the admin form may write. `desktopScheme` is reported so the
 * form can show it, but it is dropped on save — see the note at the top.
 */
const EDITABLE = new Set([
  'name', 'tagline', 'description', 'origin', 'supportEmail',
  'colorPaper', 'colorInk', 'colorMuted', 'colorLine', 'colorAccent', 'colorAccentDeep',
  'colorAccentAlt', 'colorAccentCool',
  'colorWarning', 'colorDanger',
  'displayFontFamily', 'displayFontUrl', 'bodyFontFamily', 'bodyFontUrl',
  'markUrl', 'lockupUrl', 'radius',
  'desktopProductName', 'mountFolder',
]);

/** Drop unknown and read-only keys before persisting an admin submission. */
export function sanitizeBrandSubmission(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const [k, v] of Object.entries(patch)) {
    if (!EDITABLE.has(k)) continue;
    if (v == null || v === '') continue;
    out[k] = String(v).slice(0, 400);
  }
  return out;
}
