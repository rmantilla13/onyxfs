// The virtualized grid renders only the rows rowWindow returns.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowWindow } from '../lib/virtual-rows.js';

test('at the top, the rows that fit plus the overscan', () => {
  assert.deepEqual(rowWindow({ top: 200, viewport: 900, pitch: 100, rowCount: 1000, overscan: 2 }), { start: 0, end: 9 });
});

test('scrolled deep into a large list, a small window around the viewport', () => {
  const w = rowWindow({ top: -500000, viewport: 900, pitch: 250, rowCount: 20000, overscan: 4 });
  assert.deepEqual(w, { start: 1996, end: 2008 });
  assert.ok(w.end - w.start < 20);
});

test('never past either end', () => {
  assert.deepEqual(rowWindow({ top: -10000, viewport: 900, pitch: 100, rowCount: 20, overscan: 4 }), { start: 20, end: 20 });
  assert.deepEqual(rowWindow({ top: 0, viewport: 900, pitch: 100, rowCount: 3, overscan: 4 }), { start: 0, end: 3 });
});

test('nothing to render before the row height is known', () => {
  assert.deepEqual(rowWindow({ top: 0, viewport: 900, pitch: 0, rowCount: 50 }), { start: 0, end: 0 });
  assert.deepEqual(rowWindow({ top: 0, viewport: 900, pitch: 100, rowCount: 0 }), { start: 0, end: 0 });
});

test('before and after can differ, and default to overscan', async () => {
  const { rowWindow } = await import('../lib/virtual-rows.js');
  // Scrolled 10 rows down, 4 rows fit.
  const at = { top: -1000, viewport: 400, pitch: 100, rowCount: 100 };
  assert.deepEqual(rowWindow({ ...at, overscan: 4 }), { start: 6, end: 18 });
  assert.deepEqual(rowWindow({ ...at, before: 1, after: 7 }), { start: 9, end: 21 });
  assert.deepEqual(rowWindow({ ...at, overscan: 4, after: 7 }), { start: 6, end: 21 });
});

test('overscan leans the way the list is moving, keeping the same number of rows', async () => {
  const { overscanFor } = await import('../lib/virtual-rows.js');
  assert.deepEqual(overscanFor(0, { overscan: 4 }), { before: 4, after: 4 });
  assert.deepEqual(overscanFor(1, { overscan: 4 }), { before: 1, after: 7 });
  assert.deepEqual(overscanFor(-1, { overscan: 4 }), { before: 7, after: 1 });
});

test('the first screen: every card of each row at least partly in view, from where the grid starts', async () => {
  const { firstScreenCount } = await import('../lib/virtual-rows.js');
  // A laptop: five columns at a 229px pitch, the grid 220px down a 790px window.
  assert.equal(firstScreenCount({ cols: 5, pitch: 229, top: 220, viewport: 790 }), 15);
  // A phone: two columns, the grid under the folders.
  assert.equal(firstScreenCount({ cols: 2, pitch: 192, top: 200, viewport: 844 }), 8);
  assert.equal(firstScreenCount({ cols: 5, pitch: 229, top: 0, viewport: 229 }), 5, 'a row that just fits');
  assert.equal(firstScreenCount({ cols: 5, pitch: 229, top: 0, viewport: 230 }), 10, 'and a pixel of the next');
  assert.equal(firstScreenCount({ cols: 4, pitch: 200, top: 2000, viewport: 800 }), 4, 'below the fold: still the first row');
  assert.equal(firstScreenCount({ cols: 4, pitch: 200, top: -300, viewport: 800 }), 16, 'above the top is the top');
  assert.equal(firstScreenCount({ cols: 4, pitch: 0, top: 0, viewport: 800 }), 0, 'not measured yet');
  assert.equal(firstScreenCount({ cols: 0, pitch: 200, top: 0, viewport: 800 }), 0);
});
