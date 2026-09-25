// The listing cache behind instant folder switching (lib/listing-cache.js):
// what counts as the same listing, when a cached one is shown as it is, when
// it is shown and refetched, and when it is too old to show at all — the
// rows carry presigned URLs, so "too old" is a correctness line, not taste.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createListingCache, listingKey, FRESH_MS, KEEP_MS } from '../lib/listing-cache.js';

describe('listingKey', () => {
  test('the server and the browser agree on the key for the same listing', () => {
    // The files page renders with no query, no kinds and the default sort;
    // the client's first key is built from its initial state. Equal inputs,
    // spelled differently, must give the same key.
    assert.equal(
      listingKey({ filespaceId: '', folder: 'Campaigns', sort: 'new' }),
      listingKey({ filespaceId: '', folder: 'Campaigns', query: '', kinds: [], sort: 'new' }),
    );
    assert.equal(listingKey({ query: '  sunset ' }), listingKey({ query: 'sunset' }), 'surrounding spaces are not a new search');
    assert.equal(listingKey({ kinds: ['video', 'image'] }), listingKey({ kinds: ['image', 'video'] }), 'kind order is not a new filter');
  });

  test('anything that changes the rows changes the key', () => {
    const base = { filespaceId: 'd1', folder: 'A', query: '', kinds: [], sort: 'new' };
    const k = listingKey(base);
    for (const change of [{ filespaceId: 'd2' }, { folder: 'B' }, { query: 'x' }, { kinds: ['image'] }, { sort: 'name' }]) {
      assert.notEqual(listingKey({ ...base, ...change }), k, JSON.stringify(change));
    }
    // A folder called "a","b" must not collide with two fields that join to it.
    assert.notEqual(listingKey({ folder: 'a","b' }), listingKey({ folder: 'a', query: 'b' }));
  });
});

describe('createListingCache', () => {
  const clock = () => { let t = 1_000_000; const now = () => t; now.tick = (ms) => { t += ms; }; return now; };

  test('fresh, then stale-but-shown, then gone', () => {
    const now = clock();
    const c = createListingCache({ now });
    c.set('k', { files: [1], cursor: 'c1' });
    assert.deepEqual(c.get('k'), { files: [1], cursor: 'c1', fresh: true });
    assert.equal(c.isFresh('k'), true);
    now.tick(FRESH_MS + 1);
    assert.equal(c.get('k').fresh, false, 'shown, and refetched behind it');
    assert.equal(c.isFresh('k'), false, 'so a prefetch would fetch it again');
    now.tick(KEEP_MS);
    assert.equal(c.get('k'), null, 'past KEEP_MS its signed URLs are not to be trusted');
    assert.equal(c.size, 0);
  });

  test('bounded, dropping the least recently used', () => {
    const c = createListingCache({ max: 2 });
    c.set('a', { files: [] });
    c.set('b', { files: [] });
    c.get('a'); // a is now the most recent
    c.set('c', { files: [] });
    assert.ok(c.get('a'), 'a was used, so it stays');
    assert.equal(c.get('b'), null, 'b was the least recently used');
    assert.ok(c.get('c'));
  });

  test('setting again refreshes the entry; clear drops everything', () => {
    const now = clock();
    const c = createListingCache({ now });
    c.set('k', { files: [1] });
    now.tick(FRESH_MS + 1);
    c.set('k', { files: [2] });
    assert.deepEqual(c.get('k'), { files: [2], cursor: null, fresh: true });
    c.clear();
    assert.equal(c.get('k'), null);
  });
});
