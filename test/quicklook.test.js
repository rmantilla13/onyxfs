// What Quick Look steps through and what it loads ahead of the step.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { quickLookItems, stepIndex, preloadPlan, keepDecoded, preloadUrl, positionLabel } from '../lib/quicklook.js';

const order = ['d:A', 'f:1', 'f:2', 'f:3', 'f:4'];

describe('items', () => {
  test('several selected: the selection, in view order, and stepping leaves the selection alone', () => {
    const r = quickLookItems({ order, selected: new Set(['f:3', 'd:A', 'f:1']) });
    assert.deepEqual(r.keys, ['d:A', 'f:1', 'f:3']);
    assert.equal(r.follow, false);
    assert.equal(r.index, 0);
  });

  test('several selected, opened on one of them: starts there', () => {
    const r = quickLookItems({ order, selected: new Set(['f:3', 'f:1']), start: 'f:3' });
    assert.equal(r.index, 1);
  });

  test('one or none selected: everything shown, starting at the selected item, and stepping moves the selection', () => {
    const r = quickLookItems({ order, selected: new Set(['f:2']) });
    assert.deepEqual(r.keys, order);
    assert.equal(r.follow, true);
    assert.equal(r.index, 2);
    assert.equal(quickLookItems({ order, selected: new Set(), start: 'f:4' }).index, 4);
    assert.equal(quickLookItems({ order }).index, 0);
  });
});

describe('stepping', () => {
  test('clamped at both ends', () => {
    assert.deepEqual(stepIndex(0, -1, 5), { index: 0, load: false });
    assert.deepEqual(stepIndex(2, 1, 5), { index: 3, load: false });
    assert.deepEqual(stepIndex(4, 1, 5), { index: 4, load: false });
  });
  test('at the last loaded item with more to come, it asks for the next page', () => {
    assert.deepEqual(stepIndex(4, 1, 5, { more: true }), { index: 4, load: true });
    assert.deepEqual(stepIndex(3, 1, 5, { more: true }), { index: 4, load: false });
  });
  test('empty', () => {
    assert.deepEqual(stepIndex(0, 1, 0), { index: 0, load: false });
  });
});

describe('preloading', () => {
  test('next, previous, then one more ahead in the direction of travel', () => {
    assert.deepEqual(preloadPlan(5, 20, 1), [6, 4, 7]);
    assert.deepEqual(preloadPlan(5, 20, -1), [4, 6, 3]);
  });
  test('nothing past the ends', () => {
    assert.deepEqual(preloadPlan(0, 3, -1), [1]);
    assert.deepEqual(preloadPlan(2, 3, 1), [1]);
    assert.deepEqual(preloadPlan(0, 1, 1), []);
  });
  test('decoded pictures are held for ±1, ±2 on a phone', () => {
    assert.ok(keepDecoded(6, 5));
    assert.ok(!keepDecoded(7, 5));
    assert.ok(keepDecoded(7, 5, { phone: true }));
  });
  test('a preload is the preview; the original only near, small and on a fast connection', () => {
    const withPreview = { posterUrl: 'p', url: 'o', size: 1 };
    assert.equal(preloadUrl(withPreview), 'p');
    const bare = { url: 'o', size: 5_000_000, name: 'a.jpg', mime: 'image/jpeg', kind: 'image' };
    assert.equal(preloadUrl(bare, { distance: 1, fast: true }), 'o');
    assert.equal(preloadUrl(bare, { distance: 2, fast: true }), null);
    assert.equal(preloadUrl(bare, { distance: 1, fast: false }), null);
    assert.equal(preloadUrl({ ...bare, size: 30_000_000 }, { distance: 1, fast: true }), null);
  });
  // An original the browser cannot draw is bytes for nothing: Chrome shows a
  // broken image for HEIC, TIFF, camera RAW and PSD.
  test('an original is preloaded only in a format this browser draws', () => {
    const at = (name, mime) => ({ url: 'o', size: 5_000_000, name, mime, kind: 'image' });
    for (const [name, mime] of [['a.heic', 'image/heic'], ['a.tif', 'image/tiff'], ['a.dng', 'image/x-adobe-dng'], ['a.psd', 'image/vnd.adobe.photoshop']]) {
      assert.equal(preloadUrl(at(name, mime), { distance: 1, fast: true }), null, name);
    }
    assert.equal(preloadUrl(at('a.heic', 'image/heic'), { distance: 1, fast: true, probe: { heic: true } }), 'o', 'Safari draws HEIC');
    assert.equal(preloadUrl(at('a.tif', 'image/tiff'), { distance: 1, fast: true, probe: { heic: true, tiff: true } }), 'o');
    assert.equal(preloadUrl({ ...at('a.dng', 'image/x-adobe-dng'), posterUrl: 'p' }, { distance: 1 }), 'p', 'its preview is always drawable');
  });
});

test('position label', () => {
  assert.equal(positionLabel(2, 265), '3 of 265');
  assert.equal(positionLabel(0, 1200, true), '1 of 1,200+');
  assert.equal(positionLabel(0, 0), '');
});
