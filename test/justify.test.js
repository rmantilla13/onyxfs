// The Tile layout's arithmetic (lib/justify.js): rows that fill the width,
// what a marquee touches, and where ↑ ↓ go — without a DOM.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { justifyRows, rowsInView, firstScreenTiles, tileHits, tileStep, aspectOf, MIN_ASPECT, MAX_ASPECT, DEFAULT_ASPECT } from '../lib/justify.js';

const W = 1000;
const GAP = 8;

function checkRows(layout, aspects, { width = W, gap = GAP } = {}) {
  let next = 0;
  layout.rows.forEach((row, r) => {
    assert.equal(row.start, next, 'rows are contiguous, in reading order');
    next = row.end;
    const boxes = layout.boxes.slice(row.start, row.end);
    let left = 0;
    for (const b of boxes) {
      assert.equal(b.left, left, 'boxes sit side by side with one gap between');
      assert.equal(b.top, row.top);
      assert.equal(b.height, row.height);
      left += b.width + gap;
    }
    const last = r === layout.rows.length - 1;
    if (!last) assert.equal(left - gap, width, `row ${r} fills the width to the pixel`);
    else assert.ok(left - gap <= width, 'the last row never overflows');
    // Each box keeps its picture's shape, give or take the rounding.
    boxes.forEach((b, j) => assert.ok(Math.abs(b.width / b.height - aspects[row.start + j]) < 0.06, `box ${row.start + j} aspect`));
  });
  assert.equal(next, aspects.length, 'every item is placed');
}

describe('justified rows', () => {
  test('mixed shapes fill each row and keep their aspect ratios', () => {
    const aspects = [16 / 9, 2 / 3, 1, 4 / 5, 9 / 16, 3, 4 / 3, 1.5, 2 / 3, 16 / 9, 1];
    const layout = justifyRows(aspects, { width: W, target: 200, gap: GAP });
    checkRows(layout, aspects);
    for (const row of layout.rows.slice(0, -1)) assert.ok(row.height > 120 && row.height < 300, `row height ${row.height} near the target`);
  });

  test('the last row is left at the target height rather than blown up', () => {
    const aspects = [16 / 9, 16 / 9, 16 / 9, 16 / 9, 1];
    const layout = justifyRows(aspects, { width: W, target: 200, gap: GAP });
    const last = layout.rows.at(-1);
    assert.deepEqual([last.start, last.end], [3, 5]);
    assert.equal(last.height, 200);
    assert.deepEqual(layout.boxes.slice(3).map((b) => b.width), [356, 200], 'each at its own width for the target height');
  });

  test('rows stack with the caption and one gap between them', () => {
    const layout = justifyRows(Array(12).fill(1), { width: W, target: 150, gap: GAP, caption: 40 });
    layout.rows.slice(1).forEach((row, i) => {
      const prev = layout.rows[i];
      assert.equal(row.top, prev.top + prev.height + 40 + GAP);
    });
    const last = layout.rows.at(-1);
    assert.equal(layout.height, last.top + last.height + 40);
  });

  test('a phone width puts a wide picture on a row of its own, inside the width', () => {
    const layout = justifyRows([3, 2 / 3, 2 / 3], { width: 343, target: 180, gap: GAP });
    checkRows(layout, [3, 2 / 3, 2 / 3], { width: 343 });
    assert.equal(layout.rows[0].end - layout.rows[0].start, 1);
    for (const b of layout.boxes) assert.ok(b.left + b.width <= 343);
  });

  test('nothing, and one picture, are laid out too', () => {
    assert.deepEqual(justifyRows([], { width: W, target: 200 }), { rows: [], boxes: [], height: 0 });
    const one = justifyRows([1.5], { width: W, target: 200, gap: GAP });
    assert.deepEqual(one.boxes[0], { left: 0, top: 0, width: 300, height: 200 });
  });

  test('a file without dimensions gets the grid’s box; extremes are clamped', () => {
    assert.equal(aspectOf({ metadata: {} }), DEFAULT_ASPECT);
    assert.equal(aspectOf({ metadata: { width: 1920, height: 1080 } }), 1920 / 1080);
    assert.equal(aspectOf({ metadata: { width: 10000, height: 100 } }), MAX_ASPECT);
    assert.equal(aspectOf({ metadata: { width: 100, height: 10000 } }), MIN_ASPECT);
    assert.equal(aspectOf(null), DEFAULT_ASPECT);
  });
});

describe('only the rows near the screen are drawn', () => {
  const layout = justifyRows(Array(120).fill(1), { width: W, target: 100, gap: 0 });

  test('the window covers the viewport, plus the overscan', () => {
    const rowH = layout.rows[0].height;
    const { start, end } = rowsInView(layout, rowH * 3 + 1, rowH * 5 - 1);
    assert.deepEqual({ start, end }, { start: 3, end: 5 });
    assert.deepEqual(rowsInView(layout, rowH * 3 + 1, rowH * 5 - 1, { overscan: 2 }), { start: 1, end: 7 });
    assert.deepEqual(rowsInView(layout, -500, -1), { start: 0, end: 1 }, 'above the layout: its first row');
    assert.deepEqual(rowsInView({ rows: [] }, 0, 100), { start: 0, end: 0 });
  });
});

describe('a marquee over tiles', () => {
  const layout = justifyRows([1, 1, 1, 1, 1, 1], { width: 330, target: 100, gap: 15, caption: 20 });
  const box = { left: 50, top: 100, right: 380, bottom: 1000 };

  test('takes the tiles it touches, captions included, and not the gaps', () => {
    // Row 0 is tiles 0-2 (100 wide, 15 apart); row 1 starts at 100 + 20 + 15.
    assert.deepEqual(tileHits({ rect: { left: 60, top: 110, right: 70, bottom: 120 }, box, layout, caption: 20 }), [0]);
    assert.deepEqual(tileHits({ rect: { left: 60, top: 110, right: 170, bottom: 120 }, box, layout, caption: 20 }), [0, 1]);
    assert.deepEqual(tileHits({ rect: { left: 151, top: 110, right: 164, bottom: 120 }, box, layout, caption: 20 }), [], 'the gap between two tiles');
    assert.deepEqual(tileHits({ rect: { left: 60, top: 215, right: 70, bottom: 218 }, box, layout, caption: 20 }), [0], 'a caption is part of its tile');
    assert.deepEqual(tileHits({ rect: { left: 60, top: 221, right: 70, bottom: 234 }, box, layout, caption: 20 }), [], 'the gap between rows');
    assert.deepEqual(tileHits({ rect: { left: 0, top: 0, right: 2000, bottom: 2000 }, box, layout, caption: 20 }), [0, 1, 2, 3, 4, 5]);
  });
});

describe('arrows over tiles', () => {
  // Row 0: a wide and a square; row 1: three squares.
  const layout = justifyRows([2, 1, 1, 1, 1], { width: 300, target: 100, gap: 0 });

  test('↑ ↓ land on the tile nearest the middle of this one', () => {
    assert.deepEqual(layout.rows.map((r) => [r.start, r.end]), [[0, 2], [2, 5]]);
    assert.equal(tileStep(layout, 0, 'ArrowDown', { width: 300 }), 2, 'the middle of the wide one is over the first square');
    assert.equal(tileStep(layout, 1, 'ArrowDown', { width: 300 }), 4);
    assert.equal(tileStep(layout, 3, 'ArrowUp', { width: 300 }), 0);
    assert.equal(tileStep(layout, 4, 'ArrowUp', { width: 300 }), 1);
  });

  test('off the top it says where to cross; off the bottom, nowhere', () => {
    assert.deepEqual(tileStep(layout, 1, 'ArrowUp', { width: 300 }), { cross: 'up', x: 250 / 300 });
    assert.equal(tileStep(layout, 3, 'ArrowDown', { width: 300 }), null);
    assert.equal(tileStep(layout, 3, 'ArrowLeft', { width: 300 }), null, '← → are the flat order’s');
    assert.equal(tileStep(layout, 99, 'ArrowUp', { width: 300 }), null);
  });
});

describe('the first screen of tiles', () => {
  // Squares at 100px, three to a 316px row: rows 100 + 20 + 8 apart.
  const layout = justifyRows(Array(20).fill(1), { width: 316, target: 100, gap: 8, caption: 20 });

  test('every tile of each row at least partly in view, from where the set starts', () => {
    assert.deepEqual(layout.rows.slice(0, 3).map((r) => [r.start, r.end, r.top]), [[0, 3, 0], [3, 6, 128], [6, 9, 256]]);
    assert.equal(firstScreenTiles(layout, { top: 0, viewport: 127, caption: 20 }), 3, 'the first row, and nothing of the second');
    assert.equal(firstScreenTiles(layout, { top: 0, viewport: 129, caption: 20 }), 6, 'a pixel of the second is the second');
    assert.equal(firstScreenTiles(layout, { top: 100, viewport: 400, caption: 20 }), 9);
    assert.equal(firstScreenTiles(layout, { top: 0, viewport: 10000, caption: 20 }), 20, 'all of a short set');
  });

  test('below the fold, the first row still; with no layout, none', () => {
    assert.equal(firstScreenTiles(layout, { top: 5000, viewport: 400, caption: 20 }), 3);
    assert.equal(firstScreenTiles({ rows: [] }, { top: 0, viewport: 800 }), 0);
    assert.equal(firstScreenTiles(null, { top: 0, viewport: 800 }), 0);
  });
});
