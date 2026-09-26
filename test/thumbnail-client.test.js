// The browser half of previews: what a backfilled row brings onto the one on
// screen, and the once-per-session decode probe. The drawing itself needs a
// canvas and is exercised in a browser (the perf sandbox's seed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeBackfilled } from '../lib/thumbnail-client.js';

test('a backfilled row brings its previews and facts, and keeps the signed original and the rest', () => {
  const row = { id: 'a', name: 'x.jpg', url: 'https://s3/orig?sig=listing', tags: ['t'], reviewStatus: 'approved', thumbnailUrl: null, metadata: {} };
  const f = {
    id: 'a', url: 'https://s3/orig?sig=other', tags: [], thumbnailUrl: 'https://s3/t.webp', thumbnailKey: '_thumbs/u.webp',
    smUrl: 'https://s3/t.sm.webp', xsUrl: 'https://s3/t.xs.webp', thumbSizes: ['sm', 'xs'],
    posterUrl: 'https://s3/t.poster.webp', posterKey: '_thumbs/u.poster.webp', metadata: { width: 10, height: 5 }, seq: 9,
  };
  const out = mergeBackfilled(row, f);
  assert.equal(out.url, row.url);
  assert.deepEqual(out.tags, ['t']);
  assert.equal(out.reviewStatus, 'approved');
  assert.equal(out.thumbnailUrl, f.thumbnailUrl);
  assert.equal(out.smUrl, f.smUrl);
  assert.equal(out.xsUrl, f.xsUrl);
  assert.deepEqual(out.thumbSizes, ['sm', 'xs']);
  assert.equal(out.posterUrl, f.posterUrl);
  assert.deepEqual(out.metadata, { width: 10, height: 5 });
  assert.equal(out.seq, 9);
});

test('a row for another file, or nothing, leaves the row as it was', () => {
  const row = { id: 'a', thumbnailUrl: 'u' };
  assert.equal(mergeBackfilled(row, { id: 'b', thumbnailUrl: 'v' }), row);
  assert.equal(mergeBackfilled(row, null), row);
  assert.equal(mergeBackfilled(null, { id: 'a' }), null);
});

test('only what the backfill sent is replaced', () => {
  const row = { id: 'a', thumbnailUrl: 'grid', smUrl: 'sm', posterUrl: 'p' };
  const out = mergeBackfilled(row, { id: 'a', thumbSizes: ['sm'] });
  assert.equal(out.thumbnailUrl, 'grid');
  assert.equal(out.posterUrl, 'p');
  assert.deepEqual(out.thumbSizes, ['sm']);
});

test('the decode probe asks once, and says what decoded', async () => {
  const seen = [];
  const prev = globalThis.Image;
  globalThis.Image = class {
    set src(v) {
      seen.push(v.slice(0, 16));
      const ok = v.startsWith('data:image/tiff');
      this.naturalWidth = ok ? 1 : 0;
      setTimeout(() => (ok ? this.onload?.() : this.onerror?.()), 0);
    }
  };
  try {
    const { decodeProbe, probedNow } = await import('../lib/decode-probe.js');
    assert.equal(probedNow(), null);
    const a = decodeProbe();
    const b = decodeProbe();
    assert.equal(a, b);
    assert.deepEqual(await a, { heic: false, tiff: true });
    assert.deepEqual(probedNow(), { heic: false, tiff: true });
    assert.equal(seen.length, 2);
  } finally {
    globalThis.Image = prev;
  }
});
