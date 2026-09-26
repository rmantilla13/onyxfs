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

// An original shown for an image with no preview goes to the fill-in only
// when a preview would be made from it. Every view of a GIF, a small picture
// or one skipped before used to re-upload a thumbnail, move the row's seq
// (every synced device pulled it again) and delete the one other browsers
// were showing.
test('previewWanted: only for a picture that would get a preview, and not twice', async (t) => {
  const store = new Map();
  // Swapped in by descriptor: reading Node's own localStorage getter warns.
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, writable: true,
    value: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
  });
  t.after(() => { if (prev) Object.defineProperty(globalThis, 'localStorage', prev); else delete globalThis.localStorage; });
  const { previewWanted, rememberSkip } = await import('../lib/backfill.js');
  const photo = {
    id: 'p1', storage: 's3', name: 'a.jpg', mime: 'image/jpeg', kind: 'image', size: 9_000_000,
    thumbnailKey: '_thumbs/0f8fad5b-d9cb-469f-a165-70867728950e.webp', metadata: { width: 6000, height: 4000 },
  };
  assert.equal(previewWanted(photo), true);
  assert.equal(previewWanted({ ...photo, posterUrl: 'p' }), false, 'has one');
  assert.equal(previewWanted({ ...photo, storage: 'blob' }), false);
  assert.equal(previewWanted({ ...photo, name: 'a.gif', mime: 'image/gif' }), false, 'a GIF is its own preview');
  assert.equal(previewWanted({ ...photo, size: 900_000, metadata: { width: 2000, height: 1500 } }), false, 'small: the original serves');
  assert.equal(previewWanted({ ...photo, metadata: { width: 900, height: 600 } }), false, 'barely bigger than the grid thumbnail');
  assert.equal(previewWanted({ ...photo, name: 'a.heic', mime: 'image/heic' }), false, 'not drawable here');
  assert.equal(previewWanted({ ...photo, name: 'a.heic', mime: 'image/heic' }, { probe: { heic: true } }), true);
  assert.equal(previewWanted({ ...photo, metadata: {} }), true, 'no size known: decided after the decode');
  rememberSkip('p1', 'preview');
  assert.equal(previewWanted(photo), false, 'skipped here once, not again');
  // A file with no thumbnail of ours gets its whole set from the handover.
  const bare = { ...photo, id: 'p2', thumbnailKey: null, name: 'b.gif', mime: 'image/gif' };
  assert.equal(previewWanted(bare), true);
  rememberSkip('p2');
  assert.equal(previewWanted(bare), false);
});

test('the fill-in records a preview alone, and checks the thumbnail it draws sizes from', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../lib/thumbnail-client.js', import.meta.url), 'utf8');
  const preview = src.slice(src.indexOf('async function makePreview'), src.indexOf('const previewDone'));
  assert.match(preview, /JSON\.stringify\(\{ posterKey, media: made\.media \}\)/, 'no thumbnailKey: the thumbnail stands');
  assert.ok(preview.indexOf('if (!large) return { skip: true }') < preview.indexOf('uploadThumbnail('), 'nothing uploaded when none is made');
  const sizes = src.slice(src.indexOf('async function makeSizes'), src.indexOf('async function makePreview'));
  assert.ok(sizes.indexOf('plan.thumbnailKey !== file.thumbnailKey') < sizes.indexOf('fetch(file.thumbnailUrl'), 'bails before drawing another picture');
  const pi = await readFile(new URL('../app/components/media/ProgressiveImage.js', import.meta.url), 'utf8');
  assert.match(pi, /fetch\(src, \{ mode: 'cors', cache: 'no-store', signal \}\)/, 'the original handed over is never a cached copy');
});
