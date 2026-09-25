// Drag-to-select (lib/marquee.js): which cards and rows a rectangle takes.
// Worked out from the layout rather than the DOM, because the grid and list
// are virtualized — so the layout arithmetic is the whole feature, and it is
// pinned here: the right cards, none from a gap, none past the end, and
// cards far below the window when the rectangle reaches them.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rectFrom, overlaps, gridHits, listHits, movedPast, edgeScroll } from '../lib/marquee.js';

// A 3-column grid 620 wide with 10px gaps: columns are 200 wide, at 0, 210, 420.
// Cards 150 tall, rows 160 apart.
const grid = { box: { left: 0, top: 100, right: 620, bottom: 100 + 160 * 10 }, cols: 3, pitch: 160, gap: 10, count: 10 };

describe('grid', () => {
  test('a rectangle over the first two cards of the first row takes those two', () => {
    assert.deepEqual(gridHits({ ...grid, rect: rectFrom(20, 120, 300, 180) }), [0, 1]);
  });

  test('dragged up and to the left, it is the same rectangle', () => {
    assert.deepEqual(gridHits({ ...grid, rect: rectFrom(300, 180, 20, 120) }), [0, 1]);
  });

  test('down across rows takes every card it touches, row by row', () => {
    assert.deepEqual(gridHits({ ...grid, rect: rectFrom(205, 150, 430, 420) }), [1, 2, 4, 5, 7, 8]);
  });

  test('a rectangle entirely inside a gap takes nothing', () => {
    // Between columns (200–210) and between rows (250–260).
    assert.deepEqual(gridHits({ ...grid, rect: rectFrom(202, 110, 208, 240) }), []);
    assert.deepEqual(gridHits({ ...grid, rect: rectFrom(10, 252, 600, 258) }), []);
  });

  test('never past the last file: the last row is part-full', () => {
    // Row 3 holds only index 9; the rectangle spans the whole row.
    assert.deepEqual(gridHits({ ...grid, rect: rectFrom(0, 590, 620, 620) }), [9]);
  });

  test('rows far below the window are reached by the layout, not the DOM', () => {
    const big = { ...grid, count: 3000, box: { left: 0, top: -50000, right: 620, bottom: 110000 } };
    const hits = gridHits({ ...big, rect: rectFrom(0, -50000 + 160 * 200, 620, -50000 + 160 * 200 + 10) });
    assert.deepEqual(hits, [600, 601, 602]);
  });

  test('nothing to take: no layout, no files, or a rectangle above the grid', () => {
    assert.deepEqual(gridHits({ ...grid, pitch: 0, rect: rectFrom(0, 100, 600, 600) }), []);
    assert.deepEqual(gridHits({ ...grid, count: 0, rect: rectFrom(0, 100, 600, 600) }), []);
    assert.deepEqual(gridHits({ ...grid, rect: rectFrom(0, 0, 600, 90) }), []);
  });
});

describe('list', () => {
  const list = { box: { left: 250, top: 300, right: 1200, bottom: 300 + 44 * 50 }, pitch: 44, count: 50 };

  test('rows are full width: any horizontal overlap takes the rows spanned', () => {
    assert.deepEqual(listHits({ ...list, rect: rectFrom(900, 310, 1000, 400) }), [0, 1, 2]);
  });

  test('beside the list takes nothing', () => {
    assert.deepEqual(listHits({ ...list, rect: rectFrom(0, 310, 240, 400) }), []);
  });

  test('clamped to the rows there are', () => {
    assert.deepEqual(listHits({ ...list, rect: rectFrom(300, 300 + 44 * 48 + 1, 400, 99999) }), [48, 49]);
  });
});

describe('the pieces around it', () => {
  test('touching edges overlap; apart does not', () => {
    assert.equal(overlaps({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 10, top: 10, right: 20, bottom: 20 }), true);
    assert.equal(overlaps({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 11, top: 0, right: 20, bottom: 10 }), false);
  });

  test('a small wobble is still a click', () => {
    assert.equal(movedPast(2, 2), false);
    assert.equal(movedPast(4, 3), true);
  });

  test('the page scrolls near the edges, faster closer in, and not in the middle', () => {
    assert.equal(edgeScroll(400, 800), 0);
    assert.ok(edgeScroll(2, 800) < edgeScroll(40, 800), 'up, faster at the very top');
    assert.ok(edgeScroll(40, 800) < 0);
    assert.ok(edgeScroll(798, 800) > edgeScroll(760, 800));
    assert.ok(edgeScroll(760, 800) > 0);
  });
});
