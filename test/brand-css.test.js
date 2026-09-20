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

const { brandCssVars, resolveBrand } = await import('../lib/brand-config.js');

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
