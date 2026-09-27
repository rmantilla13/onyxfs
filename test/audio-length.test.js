// An audio upload's length (lib/upload-client.js audioLength), read by the
// browser's own player from the local file — what the Audio view's Duration
// column shows. With a stand-in <audio>: the rule under test is when it
// answers, what with, and that it lets go of the file's URL every time.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { audioLength } from '../lib/upload-client.js';

let made;
let revoked;
const saved = { Audio: globalThis.Audio, create: URL.createObjectURL, revoke: URL.revokeObjectURL };

beforeEach(() => {
  made = [];
  revoked = [];
  URL.createObjectURL = () => `blob:test/${made.length}`;
  URL.revokeObjectURL = (u) => revoked.push(u);
  globalThis.Audio = class {
    constructor() { this.duration = NaN; made.push(this); }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
  };
});
afterEach(() => {
  globalThis.Audio = saved.Audio;
  URL.createObjectURL = saved.create;
  URL.revokeObjectURL = saved.revoke;
});

test('the length the player reads is the one sent', async () => {
  const p = audioLength({ name: 'take.mp3' });
  const el = made[0];
  assert.equal(el.preload, 'metadata', 'only the header is read');
  el.duration = 34.2;
  el.onloadedmetadata();
  assert.deepEqual(await p, { duration: 34.2 });
  assert.deepEqual(revoked, ['blob:test/0']);
  assert.equal(el.src, '', 'the element lets go of the file');
});

test('a file the browser cannot play has no length, and does not fail', async () => {
  const p = audioLength({ name: 'odd.xyz' });
  made[0].onerror();
  assert.deepEqual(await p, {});
  assert.equal(revoked.length, 1);
});

test('a length the player cannot tell (a stream, NaN) is none', async () => {
  const p = audioLength({ name: 'live.aac' });
  made[0].duration = Infinity;
  made[0].onloadedmetadata();
  assert.deepEqual(await p, {});
});

test('it gives up after a few seconds rather than hold the upload', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const p = audioLength({ name: 'slow.wav' });
  t.mock.timers.tick(4000);
  assert.deepEqual(await p, {});
  assert.equal(revoked.length, 1);
  // A late answer changes nothing.
  made[0].onloadedmetadata?.();
  assert.equal(revoked.length, 1);
});

test('without a browser there is nothing to ask', async () => {
  globalThis.Audio = undefined;
  assert.deepEqual(await audioLength({ name: 'x.mp3' }), {});
});
