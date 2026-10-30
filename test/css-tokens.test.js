// Tests for the stylesheets' tokens.
//
// Every colour, length and duration in app/**/*.css is meant to come from a
// custom property: the brand's, inlined by the root layout (brandCssVars),
// or one declared in globals.css. A var() nothing declares computes to its
// fallback, or to nothing — --radius-md fell back to a literal 10px for as
// long as it was read — and a hex literal in a rule is a colour the
// white-label layer and the dark scheme cannot reach. Both are caught here,
// along with the tokens' one home: the :root at the top of globals.css and
// its dark twin, not a :root wherever a section happened to want one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { brandCssVars, brandDarkCssVars, resolveBrand } = await import('../lib/brand-config.js');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const walk = (d, ext) => readdirSync(join(ROOT, d)).flatMap((e) => {
  const p = `${d}/${e}`;
  return statSync(join(ROOT, p)).isDirectory() ? walk(p, ext) : e.endsWith(ext) ? [p] : [];
});
const names = (re, s) => new Set([...s.matchAll(re)].map((m) => m[1]));

const CSS = Object.fromEntries(walk('app', '.css').map((p) => [p, read(p).replace(/\/\*[\s\S]*?\*\//g, '')]));

/**
 * The rules of a stylesheet (comments already stripped): each block that
 * holds declarations, with its selector and how deep it is nested in
 * at-rules. Enough of a parser for selectors with no braces in them, which
 * is all of ours.
 */
function rules(css) {
  const out = [];
  const stack = [];
  let buf = '';
  for (const ch of css) {
    if (ch === '{') { stack.push(buf.trim()); buf = ''; }
    else if (ch === '}') {
      const selector = stack.pop();
      if (buf.trim()) out.push({ selector, body: buf, depth: stack.length });
      buf = '';
    } else buf += ch;
  }
  return out;
}

test('every var() in a stylesheet names a property something declares', () => {
  const declared = new Set();
  for (const css of Object.values(CSS)) for (const n of names(/(--[a-z][a-z0-9-]*)\s*:/g, css)) declared.add(n);
  // The brand's, inlined on :root by the root layout.
  const brand = resolveBrand(null);
  for (const n of names(/(--[a-z][a-z0-9-]*):/g, `${brandCssVars(brand)};${brandDarkCssVars(brand)}`)) declared.add(n);
  // Set inline by a component (style={{ '--k': … }}, setProperty) …
  for (const p of walk('app', '.js')) for (const n of names(/['"`](--[a-z][a-z0-9-]*)['"`]/g, read(p))) declared.add(n);
  // … or on <html> by Onyx for Mac, whose title bar is the nav.
  for (const n of names(/setProperty\('(--[a-z][a-z0-9-]*)'/g, read('apple/OnyxMac/WebController.swift'))) declared.add(n);

  for (const [file, css] of Object.entries(CSS)) {
    for (const n of names(/var\(\s*(--[a-z][a-z0-9-]*)/g, css)) {
      assert.ok(declared.has(n), `${file} reads ${n}, which nothing declares`);
    }
  }
});

// Pure white and pure black are not brand colours: a sheen is light and a
// rim or letterboxing is dark, in either scheme and under any palette.
// Anything else is a colour, and a colour comes from the brand. White and
// black may be mixed into a token in :root, and these rules are light or
// dark by nature — a glaze over the brand's gradient, a folder's lit edge,
// the stage a picture plays on.
const LIGHT_OR_DARK = /^(?:#(?:fff|ffffff|000|000000)|rgba?\(\s*(?:0\s*,\s*0\s*,\s*0|255\s*,\s*255\s*,\s*255)\b)/i;
const LITERAL_OK = new Set([
  '.btn-primary', '.btn-primary:hover:not(:disabled)',
  '.folder-glyph-front',
  '.player-stage', '.player:fullscreen', '.player-bigplay', '.player-bigplay .icon', '.player-bigplay:hover', '.player-hover-frame',
  // A caption over a picture is lit by the picture, not the scheme.
  '.share-gallery-name',
]);

test('a rule names no colour of its own', () => {
  for (const [file, css] of Object.entries(CSS)) {
    for (const { selector, body } of rules(css)) {
      for (const [lit] of body.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi)) {
        assert.match(lit, LIGHT_OR_DARK, `${file} ${selector}: ${lit} is a colour — derive it from the brand's tokens`);
        assert.ok(/^:root/.test(selector) || LITERAL_OK.has(selector), `${file} ${selector}: ${lit} — mix it into a token in :root`);
      }
    }
  }
});

test('globals.css keeps its tokens in one place: the :root at the top and its dark twin', () => {
  const top = rules(CSS['app/globals.css']).filter((r) => r.depth === 0);
  assert.equal(top[0].selector, ':root');
  assert.equal(top[1].selector, ":root[data-theme='dark']");
  // A :root inside a media or supports query is that preference's override;
  // a bare one further down is a token declared where its reader would not
  // think to look.
  assert.deepEqual(top.slice(2).filter((r) => /^:root/.test(r.selector)).map((r) => r.selector), []);
});
