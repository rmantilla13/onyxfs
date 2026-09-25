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
