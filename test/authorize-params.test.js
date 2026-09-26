// /space/authorize is opened by two desktop apps that spell the PKCE
// challenge differently. The Mac app sends `challenge`, which the page did
// not read, so its "Sign in with your browser" always reached "Nothing to
// authorize".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeParams } from '../lib/pkce.js';

test('the Tauri spelling is read', () => {
  assert.equal(authorizeParams({ code_challenge: 'abc', state: 's1' }).challenge, 'abc');
});

test('the Mac spelling is read', () => {
  const p = authorizeParams({ challenge: 'xyz', label: 'Ricky’s MacBook Pro' });
  assert.equal(p.challenge, 'xyz');
  assert.equal(p.label, 'Ricky’s MacBook Pro');
});

test('code_challenge wins when both are sent', () => {
  assert.equal(authorizeParams({ code_challenge: 'a', challenge: 'b' }).challenge, 'a');
});

test('a label is trimmed, stripped of control characters and capped', () => {
  assert.equal(authorizeParams({ label: '  Mac\u0000\nmini ' }).label, 'Macmini');
  assert.equal(authorizeParams({ label: 'x'.repeat(200) }).label.length, 80);
});

test('repeated parameters take the first; nothing is empty strings', () => {
  assert.deepEqual(authorizeParams({ challenge: ['c1', 'c2'] }), { challenge: 'c1', state: '', label: '' });
  assert.deepEqual(authorizeParams(), { challenge: '', state: '', label: '' });
});
