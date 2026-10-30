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

import { readFileSync } from 'node:fs';
const { darkPalette, isDarkPalette, brandDarkCssVars, auraCssVars, contrast, mixHex, resolveBrand } = await import('../lib/brand-config.js');
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

// globals.css derives its surfaces, chips and controls from the brand's
// colours with color-mix(in srgb …), which is mixHex's arithmetic. The
// recipes are repeated here — the stylesheet is the reference for which rule
// each one is — so a change to a palette or to a token is checked against
// the text and the controls that sit on the result: for the Onyx defaults,
// the dark scheme derived from them, and a dark white-label brand, which
// darkPalette() leaves alone.
describe('derived tokens', () => {
  const ONYX = resolveBrand(null).visual.palette;
  // A dark brand with warm accents, the colours its example leaves out
  // filled in so that each reads where the Onyx one does.
  const WARM = {
    paper: '#1A1B1E', ink: '#F2F2F0', muted: '#A6A8AC', line: '#2E3034',
    accent: '#FF7A00', accentDeep: '#FFA14D', accentAlt: '#FF3D81', accentCool: '#4DD2FF',
    warning: '#FFB454', danger: '#FF8A8A',
  };
  const PALETTES = { 'the Onyx defaults': ONYX, 'the dark scheme': darkPalette(ONYX), 'a dark white-label brand': WARM };

  const aura = (p) => Object.fromEntries(auraCssVars(p).split(';').map((d) => d.split(':')));
  // The dark scheme and a dark brand share the dark block's recipes:
  // globals.css keys it on data-theme='dark' or data-brand='dark', and the
  // root layout sets the latter from isDarkPalette — the same test here, so
  // the table and the stylesheet cannot drift apart (the light recipes mix
  // the paper with white, and would hand a dark brand light cards).
  const isDark = isDarkPalette;
  function derive(p) {
    const a = aura(p);
    const dark = isDark(p);
    // The light scheme's page is a step below the paper and its card a step
    // above; the dark scheme's page is the paper and its card the 8% lift.
    const page = dark ? p.paper : mixHex(p.paper, p.ink, 0.03);       // --page
    const surface = mixHex(p.paper, '#ffffff', dark ? 0.08 : 0.60);  // --surface
    return {
      page,
      surface,
      sunken: mixHex(p.paper, p.ink, dark ? 0.04 : 0.06),        // --surface-sunken
      raised: mixHex(p.paper, '#ffffff', dark ? 0.14 : 0.90),    // --surface-raised: a menu, a dialog, a toast
      // The eyebrow, and the page under the top-left ones: the aura's glow
      // there is about 39% of its peak (the DRIVES label is 0.43 of the way
      // across the ellipse that fades out at 0.70), at the light scheme's
      // 18% strength — the dark scheme's 26% sits on near-black, where a
      // light text only gains.
      eyebrow: mixHex(p.muted, p.ink, 0.20),                     // .eyebrow
      glow: dark ? page : mixHex(page, p.accent, 0.18 * 0.39),   // the page under the DRIVES eyebrow
      kindGlyph: (c) => mixHex(c, p.ink, 0.40),                  // .thumb-kind on its wash
      kindWash: (c) => mixHex(mixHex(p.paper, p.ink, dark ? 0.04 : 0.06), c, 0.12), // .filecard-thumb[data-kind]
      extText: mixHex(p.ink, p.muted, 0.25),                     // .thumb-ext
      changesText: mixHex(p.warning, p.ink, 0.15),               // .review-changes pressed
      changesFill: mixHex(surface, p.warning, 0.14),
      ink2: mixHex(p.ink, p.paper, 0.28),                        // --ink-2: the second text colour
      lineStrong: mixHex(p.ink, p.paper, dark ? 0.54 : 0.55),    // --line-strong: a control's edge
      tag: mixHex(surface, p.ink, 0.06),                         // .tag: ink 6% over the card it sits on
      tagText: mixHex(p.muted, p.ink, 0.30),                     // .tag's text: muted leaning to ink
      onAura: a['--on-aura'],                                    // the label on a filled gradient
      deep: [a['--aura-a-deep'], a['--aura-b-deep']],            // the gradient's two stops
      switchKnob: a['--on-aura'],                                // .switch::after
      switchOn: a['--aura-a-deep'],                              // .switch:checked
      selectedEdge: p.accent,                                    // --selected-edge: the ring on a selected card, a toggle that is on
      selectedWash: mixHex(surface, p.accent, 0.16),             // --selected-bg's stronger end, over a card
      ring: dark ? mixHex(p.accent, '#ffffff', 0.15) : p.accent, // --ring
      hover: mixHex(surface, p.ink, dark ? 0.10 : 0.07),         // --hover-bg over a card
      hoverStrong: mixHex(surface, p.ink, dark ? 0.14 : 0.10),   // --hover-bg-strong (a menu item)
    };
  }
  const ratio = (a, b) => `${contrast(a, b).toFixed(2)}:1`;

  for (const [name, p] of Object.entries(PALETTES)) {
    test(`${name}: secondary text, labels on the aura and the selection edge`, () => {
      const d = derive(p);
      // --muted is the second text colour on the page and on a card. The
      // well (--surface-sunken) is 4.3:1 in light, so only decoration sits there.
      for (const [where, bg] of [['paper', p.paper], ['page', d.page], ['surface', d.surface]]) {
        assert.ok(contrast(p.muted, bg) >= 4.5, `muted on ${where}: ${ratio(p.muted, bg)}`);
      }
      // The card is a step above the page, and the eyebrow reads in the glow.
      if (!isDark(p)) assert.ok(contrast(d.surface, d.page) >= 1.07, `card over page: ${ratio(d.surface, d.page)}`);
      assert.ok(contrast(d.eyebrow, d.glow) >= 4.5, `eyebrow in the aura: ${ratio(d.eyebrow, d.glow)}`);
      // The label on a primary button, the avatar and the count badge.
      for (const stop of d.deep) assert.ok(contrast(d.onAura, stop) >= 4.5, `--on-aura on ${stop}: ${ratio(d.onAura, stop)}`);
      // Non-text: the edge that says "selected" (WCAG 1.4.11 asks 3:1),
      // on the page, on a card, and on the wash it edges.
      for (const [where, bg] of [['paper', p.paper], ['surface', d.surface], ['its wash', d.selectedWash]]) {
        assert.ok(contrast(d.selectedEdge, bg) >= 3, `selection edge on ${where}: ${ratio(d.selectedEdge, bg)}`);
      }
      // What is chosen keeps its words in ink, on the wash.
      assert.ok(contrast(p.ink, d.selectedWash) >= 4.5, `ink on the selection wash: ${ratio(p.ink, d.selectedWash)}`);
    });

    test(`${name}: the raised surface, the second ink and the control edge`, () => {
      const d = derive(p);
      // A menu's items, a toast's words and a link sit on the raised
      // surface; the raw accent is only ever a glyph there (a menu's tick).
      for (const [what, fg] of [['ink', p.ink], ['muted', p.muted], ['ink-2', d.ink2], ['accent-deep', p.accentDeep]]) {
        assert.ok(contrast(fg, d.raised) >= 4.5, `${what} on the raised surface: ${ratio(fg, d.raised)}`);
      }
      assert.ok(contrast(p.accent, d.raised) >= 3, `accent glyph on the raised surface: ${ratio(p.accent, d.raised)}`);
      // --ink-2 is text wherever --muted is.
      for (const [where, bg] of [['paper', p.paper], ['surface', d.surface]]) {
        assert.ok(contrast(d.ink2, bg) >= 4.5, `ink-2 on ${where}: ${ratio(d.ink2, bg)}`);
      }
      // The focus ring is non-text (3:1); so is a control's edge, which
      // each scheme mixes for it — the dark line alone is 1.2:1 on a card.
      for (const [where, bg] of [['paper', p.paper], ['surface', d.surface]]) {
        assert.ok(contrast(d.ring, bg) >= 3, `ring on ${where}: ${ratio(d.ring, bg)}`);
        assert.ok(contrast(d.lineStrong, bg) >= 3, `line-strong on ${where}: ${ratio(d.lineStrong, bg)}`);
      }
    });

    test(`${name}: a hover is visible`, () => {
      const d = derive(p);
      // Not a legibility bound — a tint only has to be seen. 4% ink was
      // 1.07:1, which the list screenshot could not show at all.
      assert.ok(contrast(d.hover, d.surface) >= 1.14, `hover on a card: ${ratio(d.hover, d.surface)}`);
      assert.ok(contrast(d.hoverStrong, d.surface) > contrast(d.hover, d.surface), 'a menu item is the stronger step');
    });
  }

  // The dark recipes reach a dark brand through <html data-brand="dark">,
  // which only the root layout sets — a server component with no DOM to
  // render into here, so its text is checked for the attribute and the test
  // it reads, and the test for the three palettes above.
  test('the root layout marks a dark brand for the stylesheet', () => {
    const layout = readFileSync(new URL('../app/layout.js', import.meta.url), 'utf8');
    assert.match(layout, /<html[^>]*data-brand=\{isDarkPalette\(brand\.visual\.palette\) \? 'dark' : undefined\}/);
    assert.equal(isDarkPalette(ONYX), false);
    assert.equal(isDarkPalette(darkPalette(ONYX)), true);
    assert.equal(isDarkPalette(WARM), true);
  });

  test('.tag text clears AA on its chip', () => {
    for (const [name, p] of Object.entries(PALETTES)) {
      const d = derive(p);
      assert.ok(contrast(d.tagText, d.tag) >= 4.5, `${name}: ${ratio(d.tagText, d.tag)}`);
    }
  });

  test("a switch's knob clears 3:1 against its checked track", () => {
    for (const [name, p] of Object.entries(PALETTES)) {
      const d = derive(p);
      assert.ok(contrast(d.switchKnob, d.switchOn) >= 3, `${name}: ${ratio(d.switchKnob, d.switchOn)}`);
    }
  });

  test('a placeholder tile: its glyph is a drawn form (3:1) and its extension is text (4.5:1) on its wash', () => {
    for (const [name, p] of Object.entries(PALETTES)) {
      const d = derive(p);
      for (const [kind, c] of [['video', p.accent], ['image', p.accentAlt], ['audio', p.accentCool], ['doc', p.warning], ['other', p.muted]]) {
        const wash = d.kindWash(c);
        assert.ok(contrast(d.kindGlyph(c), wash) >= 3, `${name}, ${kind} glyph: ${ratio(d.kindGlyph(c), wash)}`);
        assert.ok(contrast(d.extText, wash) >= 4.5, `${name}, ${kind} extension: ${ratio(d.extText, wash)}`);
      }
    }
  });

  test('"Changes requested", pressed, keeps its words legible on its tint', () => {
    for (const [name, p] of Object.entries(PALETTES)) {
      const d = derive(p);
      assert.ok(contrast(d.changesText, d.changesFill) >= 4.5, `${name}: ${ratio(d.changesText, d.changesFill)}`);
    }
  });
});
