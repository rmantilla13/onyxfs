// The sync feed's rows leave out the pictures a row's metadata carries for
// tiles — the placeholder and a sound's waveform (lib/media.js syncFeedRow) —
// and keep everything else, the rest of the metadata included.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncFeedRow, FEED_OMITTED_KEYS, MEDIA_KEYS } from '../lib/media.js';

test('the placeholder and the waveform are left out, and nothing else', () => {
  const row = {
    id: 'f1', name: 'a.jpg', size: 10, url: 'https://bucket/a.jpg?sig',
    metadata: { width: 4000, height: 3000, placeholder: 'data:image/webp;base64,UklGR', waveform: '1:AAAA', tags: ['x'] },
  };
  const out = syncFeedRow(row);
  assert.deepEqual(out.metadata, { width: 4000, height: 3000, tags: ['x'] });
  assert.equal(out.url, row.url);
  assert.equal(out.name, 'a.jpg');
  // The row it was given is left as it was.
  assert.equal(row.metadata.placeholder, 'data:image/webp;base64,UklGR');
  assert.equal(row.metadata.waveform, '1:AAAA');
});

test('a row with neither is handed back as it is', () => {
  const row = { id: 'f2', metadata: { width: 1, height: 1 } };
  assert.equal(syncFeedRow(row), row);
  const bare = { id: 'f3' };
  assert.equal(syncFeedRow(bare), bare);
  const nulled = { id: 'f4', metadata: null };
  assert.equal(syncFeedRow(nulled), nulled);
});

test('only media keys are ever left out', () => {
  for (const k of FEED_OMITTED_KEYS) assert.ok(MEDIA_KEYS.includes(k), k);
});
