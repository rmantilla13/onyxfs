// Where the arrow keys go: within a grid, across its ragged last row, from
// the folder tiles into the files and back, and in a one-column phone grid.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { navTarget, flatIndex, posOf, rowsPerViewport } from '../lib/nav-geometry.js';

// Folders: 5 tiles in 4 columns (rows: 0-3, 4). Files: 10 cards in 3 columns
// (rows: 0-2, 3-5, 6-8, 9).
const pane = [{ count: 5, cols: 4 }, { count: 10, cols: 3 }];
const go = (pos, key, opts) => navTarget(pane, pos, key, opts);

describe('within a section', () => {
  test('right and left step, wrapping at the end of a row', () => {
    assert.deepEqual(go({ s: 1, i: 0 }, 'ArrowRight'), { s: 1, i: 1 });
    assert.deepEqual(go({ s: 1, i: 2 }, 'ArrowRight'), { s: 1, i: 3 });
    assert.deepEqual(go({ s: 1, i: 3 }, 'ArrowLeft'), { s: 1, i: 2 });
  });

  test('down and up move a whole row', () => {
    assert.deepEqual(go({ s: 1, i: 1 }, 'ArrowDown'), { s: 1, i: 4 });
    assert.deepEqual(go({ s: 1, i: 7 }, 'ArrowUp'), { s: 1, i: 4 });
  });

  test('down into a ragged last row too short for the column lands on its last item', () => {
    assert.deepEqual(go({ s: 1, i: 8 }, 'ArrowDown'), { s: 1, i: 9 });
    assert.deepEqual(go({ s: 1, i: 7 }, 'ArrowDown'), { s: 1, i: 9 });
    assert.deepEqual(go({ s: 0, i: 3 }, 'ArrowDown'), { s: 0, i: 4 });
  });
});

describe('crossing sections', () => {
  test('down from the last row of the folders lands on the file nearest below', () => {
    // Folder 4 is column 0 of 4 (centre 0.125) → file column 0 of 3.
    assert.deepEqual(go({ s: 0, i: 4 }, 'ArrowDown'), { s: 1, i: 0 });
  });

  test('down from a folder row with none below it, by horizontal centre', () => {
    // A 4-folder single row: column 3 (centre 0.875) → file column 2.
    const one = [{ count: 4, cols: 4 }, { count: 10, cols: 3 }];
    assert.deepEqual(navTarget(one, { s: 0, i: 3 }, 'ArrowDown'), { s: 1, i: 2 });
    // Column 1 (centre 0.375) is nearest file column 1 (0.5), not 0 (0.167).
    assert.deepEqual(navTarget(one, { s: 0, i: 1 }, 'ArrowDown'), { s: 1, i: 1 });
    assert.deepEqual(navTarget(one, { s: 0, i: 2 }, 'ArrowDown'), { s: 1, i: 1 });
    assert.deepEqual(navTarget(one, { s: 0, i: 0 }, 'ArrowDown'), { s: 1, i: 0 });
  });

  test('up from the first row of files lands in the last row of folders, clamped to its items', () => {
    // File column 2 (centre 0.833) → folder column 3 of the last row, which
    // has only item 4 (column 0) → item 4.
    assert.deepEqual(go({ s: 1, i: 2 }, 'ArrowUp'), { s: 0, i: 4 });
    const full = [{ count: 8, cols: 4 }, { count: 10, cols: 3 }];
    assert.deepEqual(navTarget(full, { s: 1, i: 2 }, 'ArrowUp'), { s: 0, i: 7 });
    assert.deepEqual(navTarget(full, { s: 1, i: 0 }, 'ArrowUp'), { s: 0, i: 4 });
  });

  test('right from the last folder is the first file; left from the first file is the last folder', () => {
    assert.deepEqual(go({ s: 0, i: 4 }, 'ArrowRight'), { s: 1, i: 0 });
    assert.deepEqual(go({ s: 1, i: 0 }, 'ArrowLeft'), { s: 0, i: 4 });
  });

  test('an empty section is skipped', () => {
    const noFolders = [{ count: 0, cols: 4 }, { count: 3, cols: 3 }];
    assert.equal(navTarget(noFolders, { s: 1, i: 0 }, 'ArrowUp'), null);
    assert.equal(navTarget(noFolders, { s: 1, i: 0 }, 'ArrowLeft'), null);
  });
});

describe('the edges of the pane', () => {
  test('nothing past the first or last item', () => {
    assert.equal(go({ s: 0, i: 0 }, 'ArrowLeft'), null);
    assert.equal(go({ s: 0, i: 1 }, 'ArrowUp'), null);
    assert.equal(go({ s: 1, i: 9 }, 'ArrowRight'), null);
    assert.equal(go({ s: 1, i: 9 }, 'ArrowDown'), null);
  });

  test('Home and End are the whole pane', () => {
    assert.deepEqual(go({ s: 1, i: 5 }, 'Home'), { s: 0, i: 0 });
    assert.deepEqual(go({ s: 0, i: 1 }, 'End'), { s: 1, i: 9 });
  });

  test('with no position, a move starts at the first item', () => {
    assert.deepEqual(go(null, 'ArrowDown'), { s: 0, i: 0 });
    assert.deepEqual(go({ s: 1, i: 99 }, 'ArrowRight'), { s: 0, i: 0 });
    assert.equal(go(null, 'Enter'), null);
  });

  test('an empty pane goes nowhere', () => {
    assert.equal(navTarget([{ count: 0, cols: 3 }], null, 'ArrowDown'), null);
  });
});

describe('pages', () => {
  test('PageDown moves rows at a time, crossing sections, then stops at the end', () => {
    assert.deepEqual(go({ s: 1, i: 0 }, 'PageDown', { rowsPerPage: 2 }), { s: 1, i: 6 });
    assert.deepEqual(go({ s: 0, i: 0 }, 'PageDown', { rowsPerPage: 3 }), { s: 1, i: 3 });
    assert.deepEqual(go({ s: 1, i: 6 }, 'PageDown', { rowsPerPage: 5 }), { s: 1, i: 9 });
    assert.equal(go({ s: 1, i: 9 }, 'PageDown', { rowsPerPage: 5 }), null);
  });
  test('PageUp likewise', () => {
    assert.deepEqual(go({ s: 1, i: 9 }, 'PageUp', { rowsPerPage: 2 }), { s: 1, i: 3 });
    assert.equal(go({ s: 0, i: 0 }, 'PageUp', { rowsPerPage: 2 }), null);
  });
  test('rows per viewport keeps one row of context', () => {
    assert.equal(rowsPerViewport(900, 200), 3);
    assert.equal(rowsPerViewport(100, 200), 1);
    assert.equal(rowsPerViewport(0, 0), 1);
  });
});

describe('one column (the list, or a phone grid)', () => {
  const list = [{ count: 2, cols: 1 }, { count: 4, cols: 1 }];
  test('down and right are the next item, across sections', () => {
    assert.deepEqual(navTarget(list, { s: 0, i: 1 }, 'ArrowDown'), { s: 1, i: 0 });
    assert.deepEqual(navTarget(list, { s: 0, i: 1 }, 'ArrowRight'), { s: 1, i: 0 });
    assert.deepEqual(navTarget(list, { s: 1, i: 0 }, 'ArrowUp'), { s: 0, i: 1 });
    assert.deepEqual(navTarget(list, { s: 1, i: 2 }, 'ArrowDown'), { s: 1, i: 3 });
  });
});

test('flat index and position agree', () => {
  assert.equal(flatIndex(pane, { s: 0, i: 4 }), 4);
  assert.equal(flatIndex(pane, { s: 1, i: 0 }), 5);
  assert.equal(flatIndex(pane, { s: 1, i: 10 }), -1);
  assert.deepEqual(posOf(pane, 5), { s: 1, i: 0 });
  assert.deepEqual(posOf(pane, 14), { s: 1, i: 9 });
  assert.equal(posOf(pane, 15), null);
  assert.equal(posOf(pane, -1), null);
});
