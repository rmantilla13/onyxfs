// The files page's collections, held for the document (lib/held-list.js):
// kept in the browser across remounts, and never on the server, where a
// module is shared by every request — a list kept there would be rendered
// into the next person's page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldList } from '../lib/held-list.js';

test('on the server nothing is kept: one person’s list never reaches the next render', () => {
  assert.equal(typeof window, 'undefined');
  const held = heldList();
  assert.deepEqual(held.set([{ id: 'a', name: 'Finance only' }], 'a@x.test'), [{ id: 'a', name: 'Finance only' }], 'set hands back what it was given');
  assert.equal(held.get('a@x.test'), null, 'and keeps none of it');
});

test('in the browser the list is kept, and only the newest answer counts', () => {
  globalThis.window = {};
  try {
    const held = heldList();
    assert.equal(held.get('a@x.test'), null);
    held.set(['x'], 'a@x.test');
    assert.deepEqual(held.get('a@x.test'), ['x']);
    assert.equal(held.get('b@x.test'), null, 'the tab signed in as someone else since: not theirs');
    assert.equal(held.get(null), null);
    const older = held.ask();
    const newer = held.ask();
    assert.equal(held.newest(older), false, 'a slower, older answer is not taken');
    assert.equal(held.newest(newer), true);
  } finally {
    delete globalThis.window;
  }
});
