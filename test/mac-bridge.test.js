import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// window.onyxMac is defined in Swift (WebController's bridge script) and
// called from React. Nothing type-checks one against the other, so a rename
// on either side would leave a button that silently does nothing.
test('every bridge call the web makes is one the app defines', () => {
  const swift = read('apple/OnyxMac/WebController.swift');
  const script = swift.slice(swift.indexOf('private static let bridgeScript'));
  const defined = new Set([...script.matchAll(/^\s{8}([a-zA-Z]+): \(/gm)].map((m) => m[1]));
  const web = ['app/components/useMacApp.js', 'app/components/mac/useMacBar.js'].map(read).join('\n');
  const called = new Set([...web.matchAll(/mac(?:\(\))?\?*\.([a-zA-Z]+)\??\.?\(/g)].map((m) => m[1]));
  assert.ok(called.size >= 8, `found ${[...called]}`);
  for (const name of called) assert.ok(defined.has(name), `window.onyxMac.${name} is called by the web but not defined by the app`);
});

test('every message the bridge posts is one the app handles', () => {
  const swift = read('apple/OnyxMac/WebController.swift');
  const script = swift.slice(swift.indexOf('private static let bridgeScript'));
  const posted = new Set([...script.matchAll(/post\(\{ type: '([a-zA-Z]+)'/g)].map((m) => m[1]));
  const handled = new Set([...swift.matchAll(/case "([a-zA-Z]+)":/g)].map((m) => m[1]));
  for (const type of posted) assert.ok(handled.has(type), `the bridge posts "${type}" but received() has no case for it`);
});

test('the bar is laid out for the title bar before the page paints', () => {
  const swift = read('apple/OnyxMac/WebController.swift');
  // Set on <html> by the document-start script, not by React after hydration.
  assert.match(swift, /setAttribute\('data-mac-app'/);
  assert.match(swift, /--mac-left/);
  assert.match(swift, /--mac-bar-h/);
  const css = read('app/globals.css');
  assert.match(css, /html\[data-mac-app\] \.topnav-row \{[^}]*var\(--mac-bar-h/);
  assert.match(css, /html\[data-mac-app\] \.topnav-row \{[^}]*var\(--mac-left/);
});
