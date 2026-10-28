// Tests for the brand's inlined CSS custom properties.
//
// Regression for a production bug that looked like "some CSS isn't
// rendering". The root layout emitted the variables as a TEXT CHILD of
// <style>, so React HTML-escaped them on the server and the font stack went
// out as:
//
//   --font-display:&#x27;Inter Tight&#x27;, …
//
// A <style> element is raw text — the browser does not decode entities — so
// that is simply invalid CSS and the font fell back. Worse, the client does
// not escape, so its text differed from the server's and React threw away
// the whole server-rendered root and re-rendered on the client (the 418 /
// 423 / 425 errors in the console).
//
// The fix is dangerouslySetInnerHTML, which means the values can no longer
// be escaped out of trouble and must be sanitized instead. Both halves are
// asserted here.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { brandCssVars, brandDarkCssVars, resolveBrand, sanitizeBrandSubmission, withAccent, withKit, contrast } = await import('../lib/brand-config.js');

describe('brandCssVars', () => {
  test('emits font families unescaped', () => {
    // THE regression. An HTML entity here is broken CSS, not safe CSS.
    const css = brandCssVars(resolveBrand(null));
    assert.ok(!/&#x27;|&quot;|&amp;|&lt;|&gt;/.test(css), `entity in CSS: ${css}`);
    assert.match(css, /--font-display:'Inter Tight'/);
  });

  test('a value cannot close the style element', () => {
    // Inlined with dangerouslySetInnerHTML, so this is the only defence.
    const css = brandCssVars(resolveBrand({ displayFontFamily: '</style><script>alert(1)</script>' }));
    assert.ok(!css.includes('<'), 'a < survived into the stylesheet');
    assert.ok(!css.includes('>'), 'a > survived into the stylesheet');
    assert.ok(!/<\/style/i.test(css));
  });

  test('a value cannot escape its declaration', () => {
    const css = brandCssVars(resolveBrand({ radius: '8px} body{display:none' }));
    assert.ok(!css.includes('{') && !css.includes('}'), `brace survived: ${css}`);
    // The whole thing is wrapped in one :root{…} block by the layout, so a
    // stray semicolon only ends this declaration — but a brace would let a
    // saved brand hide the entire page.
    assert.match(css, /--radius:8px/);
  });

  test('every declaration is well formed', () => {
    const css = brandCssVars(resolveBrand(null));
    for (const decl of css.split(';')) {
      assert.match(decl, /^--[a-z-]+:.+$/, `malformed declaration: ${decl}`);
    }
  });
});

// The logo is a wordmark that spells our name, in two versions: dark letters
// for paper and light ones for the dark scheme. A deployment that is no
// longer ours must not go on wearing it.
describe('the logo', () => {
  test('ours by default: the wordmark, and a light-lettered one for the dark scheme', () => {
    const { logo } = resolveBrand(null).visual;
    assert.equal(logo.lockupPath, '/onyx-lockup.svg');
    assert.equal(logo.lockupDarkPath, '/onyx-lockup-dark.svg');
    assert.equal(logo.markPath, '/onyx-mark.png', 'the path emails already sent point at');
    assert.equal(logo.onyxWordmark, true, 'drawn inline, so it can follow the theme and animate');
  });

  test('a renamed or re-marked deployment keeps its own mark and name, not our wordmark', () => {
    for (const saved of [{ name: 'Acme Files' }, { markUrl: 'https://acme.example/mark.png' }]) {
      const { logo } = resolveBrand(saved).visual;
      assert.equal(logo.lockupPath, null, JSON.stringify(saved));
      assert.equal(logo.lockupDarkPath, null, JSON.stringify(saved));
      assert.equal(logo.onyxWordmark, false, JSON.stringify(saved));
    }
  });

  test('a wordmark of its own is used, in both schemes unless it gives a dark one', () => {
    assert.deepEqual(
      resolveBrand({ name: 'Acme Files', lockupUrl: '/acme.svg' }).visual.logo,
      { markPath: '/onyx-mark.png', lockupPath: '/acme.svg', lockupDarkPath: '/acme.svg', onyxWordmark: false },
    );
    assert.equal(resolveBrand({ lockupUrl: '/acme.svg', lockupDarkUrl: '/acme-dark.svg' }).visual.logo.lockupDarkPath, '/acme-dark.svg');
  });

  test('saving our own defaults back does not count as a change', () => {
    const { logo } = resolveBrand({ name: 'Onyx', markUrl: '/onyx-mark.png', lockupUrl: '/onyx-lockup.svg' }).visual;
    assert.equal(logo.lockupDarkPath, '/onyx-lockup-dark.svg', 'the light wordmark must never stand in for the dark one');
  });

  test('the dark wordmark can be set from the admin form', () => {
    assert.deepEqual(sanitizeBrandSubmission({ lockupDarkUrl: '/x.svg' }), { lockupDarkUrl: '/x.svg' });
  });
});

describe('withAccent (a share link\'s own accent)', () => {
  test('swaps the accent and draws the aura from it, nothing else', () => {
    const brand = resolveBrand(null);
    const b = withAccent(brand, '#1D4ED8');
    assert.equal(b.visual.palette.accent.toUpperCase(), '#1D4ED8', 'already legible: kept as chosen');
    assert.notEqual(b.visual.palette.accentAlt, brand.visual.palette.accentAlt);
    assert.equal(b.visual.palette.paper, brand.visual.palette.paper);
    assert.equal(b.name, brand.name);
    assert.deepEqual(b.visual.fonts, brand.visual.fonts);
    assert.match(brandCssVars(b), /--accent:#1d4ed8/i);
    assert.match(brandDarkCssVars(b), /--accent:#/);
  });

  test('a pale accent is deepened until it reads as text on the paper', () => {
    const brand = resolveBrand(null);
    const b = withAccent(brand, '#FDE68A');
    assert.ok(contrast(b.visual.palette.accent, brand.visual.palette.paper) >= 4.5);
  });

  test('anything but #rrggbb is the brand unchanged', () => {
    const brand = resolveBrand(null);
    for (const bad of [null, '', 'red', '#abc', '#abcdef;}</style>']) assert.equal(withAccent(brand, bad), brand, String(bad));
  });
});

describe('withKit (a brand kit on a share link\'s page)', () => {
  const kit = { id: 'kAcme12345', name: 'Acme', logoUrl: '/brand/acme.svg', accent: '#BE185D' };

  test('swaps the logo for the kit\'s, in both schemes, and keeps the rest of the brand', () => {
    const brand = resolveBrand(null);
    const b = withKit(brand, kit);
    assert.deepEqual(b.visual.logo, { markPath: brand.visual.logo.markPath, lockupPath: '/brand/acme.svg', lockupDarkPath: '/brand/acme.svg', onyxWordmark: false });
    assert.equal(withKit(brand, { ...kit, logoDarkUrl: '/brand/acme-dark.svg' }).visual.logo.lockupDarkPath, '/brand/acme-dark.svg');
    assert.equal(b.name, brand.name, 'the page still says whose workspace it is');
    assert.deepEqual(b.visual.palette, brand.visual.palette, 'the accent is laid on after, by withAccent');
    assert.deepEqual(b.visual.fonts, brand.visual.fonts, 'no font of its own: the workspace\'s');
  });

  test('a kit\'s display font reaches the stylesheet, sanitized as the brand\'s is', () => {
    const b = withKit(resolveBrand(null), { ...kit, displayFontFamily: "'Fraunces', serif", displayFontUrl: 'https://fonts.test/f.css' });
    assert.equal(b.visual.fonts.display.url, 'https://fonts.test/f.css');
    assert.match(brandCssVars(b), /--font-display:'Fraunces', serif/);
    assert.equal(b.visual.fonts.body.family, resolveBrand(null).visual.fonts.body.family);
    const hostile = withKit(resolveBrand(null), { ...kit, displayFontFamily: 'X;}</style><script>' });
    assert.ok(!/[<>]/.test(brandCssVars(hostile)));
  });

  test('then a link\'s accent over the kit\'s, in light and dark', () => {
    const brand = resolveBrand(null);
    const kitted = withAccent(withKit(brand, kit), kit.accent);
    assert.equal(kitted.visual.palette.accent.toUpperCase(), '#BE185D');
    assert.match(brandDarkCssVars(kitted), /--accent:#/);
    assert.notEqual(brandDarkCssVars(kitted), brandDarkCssVars(brand));
    const own = withAccent(withKit(brand, kit), '#1D4ED8');
    assert.equal(own.visual.palette.accent.toUpperCase(), '#1D4ED8');
    assert.equal(own.visual.logo.lockupPath, '/brand/acme.svg');
  });

  test('no kit is the brand unchanged', () => {
    const brand = resolveBrand(null);
    assert.equal(withKit(brand, null), brand);
  });
});
