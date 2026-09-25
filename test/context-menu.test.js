// Context menu placement, file-name rules and the object-name sanitizer that
// renames share with uploads.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { placeMenu } from '../lib/menu-place.js';
import { fileNameProblem } from '../lib/folder-ops.js';

const { safeObjectName, buildObjectKey } = await import('../lib/storage.js');

describe('placeMenu', () => {
  const vw = 1280, vh = 800, w = 220, h = 300;

  test('opens at the pointer when it fits', () => {
    assert.deepEqual(placeMenu({ x: 100, y: 120, w, h, vw, vh }), { left: 100, top: 120 });
  });

  test('flips left and up near the bottom-right corner', () => {
    assert.deepEqual(placeMenu({ x: 1270, y: 790, w, h, vw, vh }), { left: 1050, top: 490 });
  });

  test('on a phone it is clamped inside the viewport, never off either edge', () => {
    // 390px wide: a 220px menu opened at x=300 flips to 80; at x=150 it cannot
    // flip left (would be -70) and is clamped to the margin instead.
    for (const x of [0, 5, 150, 300, 385]) {
      const { left, top } = placeMenu({ x, y: 400, w, h, vw: 390, vh: 844 });
      assert.ok(left >= 8 && left + w <= 390 - 8, `x=${x} → left ${left}`);
      assert.ok(top >= 8 && top + h <= 844 - 8);
    }
  });

  test('a menu taller than the screen is pinned to the top margin', () => {
    assert.equal(placeMenu({ x: 10, y: 10, w, h: 2000, vw, vh }).top, 8);
  });

  test('keyboard opening goes under the anchor, or above it when there is no room', () => {
    const below = placeMenu({ w, h, vw, vh, anchor: { left: 40, top: 100, bottom: 140 } });
    assert.deepEqual(below, { left: 40, top: 142 });
    const above = placeMenu({ w, h, vw, vh, anchor: { left: 40, top: 700, bottom: 740 } });
    assert.deepEqual(above, { left: 40, top: 398 });
  });
});

describe('fileNameProblem', () => {
  test('accepts ordinary names, including unicode and spaces', () => {
    for (const n of ['a.png', 'Q3 review (final).mov', 'café.jpg', '.env']) assert.equal(fileNameProblem(n), null, n);
  });
  test('rejects empty, slashes, dot names, control characters and very long names', () => {
    for (const n of ['', '   ', 'a/b.png', '.', '..', 'a\u0000b', 'x'.repeat(256)]) assert.ok(fileNameProblem(n), JSON.stringify(n));
  });
});

describe('safeObjectName', () => {
  test('is what an upload uses for the last key segment', () => {
    for (const n of ['Shot 01.mov', 'a/b (2).mov', 'café—final.jpg', '..', '']) {
      const key = buildObjectKey({ prefix: 'files' }, n, '');
      assert.equal(key, `files/${safeObjectName(n)}`);
    }
  });
  test('keeps safe characters and replaces the rest', () => {
    assert.equal(safeObjectName('Q3 review (final)-v2_x.mov'), 'Q3 review (final)-v2_x.mov');
    assert.equal(safeObjectName('café.jpg'), 'caf_.jpg');
    assert.equal(safeObjectName('..'), 'file');
  });
});
