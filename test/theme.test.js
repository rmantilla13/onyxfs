// Tests for dark mode: the derived palette and the no-flash script.
//
// The palette is derived from whatever colours an admin saved, so its
// legibility cannot be checked once by eye and trusted — it is asserted here
// for the Onyx defaults and for a deliberately awkward white-label palette.
// The script runs before any bundle, where no test framework can reach it in
// a browser, so it is executed here against a stub document.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { darkPalette, brandDarkCssVars, contrast, mixHex, resolveBrand } = await import('../lib/brand-config.js');
const { THEME_SCRIPT, THEME_KEY, resolveTheme } = await import('../lib/theme.js');

const TEXT = ['ink', 'muted', 'accent', 'accentDeep', 'warning', 'danger'];

function assertLegible(p) {
  // --surface in globals.css: the lightest background text sits on.
  const surface = mixHex(p.paper, '#ffffff', 0.08);
  for (const k of TEXT) {
    for (const [where, bg] of [['paper', p.paper], ['surface', surface], ['own tint', mixHex(surface, p[k], 0.14)]]) {
      const r = contrast(p[k], bg);
      assert.ok(r >= 4.5, `${k} ${p[k]} on ${where} ${bg} is ${r.toFixed(2)}:1`);
    }
  }
  // Primary buttons and the error toast put paper on these.
  assert.ok(contrast(p.paper, p.ink) >= 4.5);
  assert.ok(contrast(p.paper, p.accentDeep) >= 4.5);
  assert.ok(contrast(p.paper, p.danger) >= 4.5);
}

describe('darkPalette', () => {
  test('the Onyx defaults clear WCAG AA in the dark scheme', () => {
    const d = darkPalette(resolveBrand(null).visual.palette);
    assert.equal(d.paper, '#0C0D0F', 'the page should be the brand ink');
    assertLegible(d);
  });

  test('a white-label palette with low-contrast colours is lifted to AA', () => {
    const p = resolveBrand({
      colorPaper: '#FFFFFF', colorInk: '#1E2A4A', colorMuted: '#4B5563', colorLine: '#DDDDDD',
      colorAccent: '#1D4ED8', colorAccentDeep: '#1E3A8A', colorWarning: '#92400E', colorDanger: '#7F1D1D',
    }).visual.palette;
    assertLegible(darkPalette(p));
  });

  test('a brand that is already dark is left alone', () => {
    const p = { paper: '#101010', ink: '#F0F0F0', muted: '#999999', line: '#333333', accent: '#88AAFF', accentDeep: '#99BBFF', warning: '#FFAA66', danger: '#FF8877' };
    assert.deepEqual(darkPalette(p), p);
  });

  test('emits only well-formed, sanitized colour declarations', () => {
    const css = brandDarkCssVars(resolveBrand(null));
    for (const decl of css.split(';')) assert.match(decl, /^--[a-z-]+:#[0-9a-fA-F]{6}$/, `malformed: ${decl}`);
    assert.match(css, /--paper:/);
    assert.ok(!css.includes('--font'), 'fonts do not change with the scheme');
  });
});

describe('theme script', () => {
  function run({ saved, osDark }) {
    const listeners = {};
    const html = { dataset: {} };
    const ctx = {
      document: { documentElement: html },
      localStorage: { getItem: (k) => (k === THEME_KEY ? saved ?? null : null) },
      matchMedia: () => ({ matches: osDark, addEventListener: (t, fn) => { listeners.media = fn; } }),
      addEventListener: (t, fn) => { listeners[t] = fn; },
    };
    vm.runInNewContext(THEME_SCRIPT, ctx);
    return { html, ctx, listeners };
  }

  test('follows the OS when nothing is saved', () => {
    assert.equal(run({ osDark: true }).html.dataset.theme, 'dark');
    assert.equal(run({ osDark: false }).html.dataset.theme, 'light');
  });

  test('a saved choice beats the OS', () => {
    assert.equal(run({ saved: 'light', osDark: true }).html.dataset.theme, 'light');
    assert.equal(run({ saved: 'dark', osDark: false }).html.dataset.theme, 'dark');
  });

  test('ignores a junk value', () => {
    assert.equal(run({ saved: 'purple', osDark: true }).html.dataset.theme, 'dark');
  });

  test('never throws, even when storage does', () => {
    const html = { dataset: {} };
    vm.runInNewContext(THEME_SCRIPT, {
      document: { documentElement: html },
      localStorage: { getItem: () => { throw new Error('SecurityError'); } },
      matchMedia: () => ({ matches: true, addEventListener() {} }),
      addEventListener() {},
    });
    assert.equal(html.dataset.theme, 'dark');
  });

  test('agrees with resolveTheme', () => {
    for (const saved of ['light', 'dark', 'system', null]) {
      for (const osDark of [true, false]) {
        assert.equal(run({ saved, osDark }).html.dataset.theme, resolveTheme(saved, osDark), `${saved}/${osDark}`);
      }
    }
  });
});
