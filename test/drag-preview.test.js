// The picture a move drags (lib/drag-preview.js, drawn by app/files/DragPreview.js):
// what it shrinks to, how it is laid out so it is only ever scaled down,
// where it hangs beside the pointer, the springs that move it, and — the
// part a mistake would cost a file — where a drop may go and which folders
// spring open under it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPACT, CHIP_H, HANG, MARGIN, SPRINGS, SWAY,
  compactBox, previewLayout, hangAt, stepSpring, atRest, swayFor,
  describeFiles, classifyDrop, isDroppable, isRefused, springsOpen,
} from '../lib/drag-preview.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

describe('the thumbnail it shrinks to', () => {
  test("a grid card's 4:3 picture keeps its shape at a share of its size", () => {
    const c = compactBox({ width: 240, height: 180 });
    near(c.width, 240 * COMPACT.share);
    near(c.width / c.height, 4 / 3);
  });

  test('a big picture stops at the largest thumbnail, a list row grows to the smallest', () => {
    assert.equal(compactBox({ width: 900, height: 600 }).width, COMPACT.max);
    const row = compactBox({ width: 44, height: 33 });
    assert.equal(row.width, COMPACT.min);
    near(row.width / row.height, 4 / 3);
  });

  test('a portrait picture is bounded by its height', () => {
    const c = compactBox({ width: 158, height: 210 });
    assert.ok(c.height >= c.width);
    assert.ok(c.height <= COMPACT.max && c.height >= COMPACT.min);
  });

  test('a strip of a panorama is held to 2:1, and nothing measured still gets a shape', () => {
    const pano = compactBox({ width: 1200, height: 150 });
    near(pano.width / pano.height, 2);
    const none = compactBox({ width: 0, height: NaN });
    near(none.width / none.height, 4 / 3);
    assert.ok(none.width >= COMPACT.min);
  });
});

describe('laid out once, only ever scaled down', () => {
  test('a card: laid out at its own size, shown there at scale 1, then shrunk', () => {
    const from = { width: 240, height: 180 };
    const c = compactBox(from);
    const l = previewLayout(from, c);
    near(l.width, 240);
    near(l.height, 180);
    assert.equal(l.start, 1);
    near(l.compact * l.width, c.width);
    near(l.k, 240 / c.width);
  });

  test('a list row: laid out at the thumbnail size and grown into it from the row', () => {
    const from = { width: 44, height: 33 };
    const c = compactBox(from);
    const l = previewLayout(from, c);
    assert.equal(l.k, 1);
    assert.equal(l.compact, 1);
    near(l.start * l.height, 33);
  });

  test('no scale it is shown at is ever above 1', () => {
    for (const from of [{ width: 44, height: 33 }, { width: 300, height: 225 }, { width: 158, height: 210 }, { width: 2000, height: 1500 }]) {
      const l = previewLayout(from, compactBox(from));
      assert.ok(l.start <= 1 && l.compact <= 1, JSON.stringify(from));
    }
  });

  test("a folder's chip: height decides — a tile shrinks to it, a tree row grows to it", () => {
    const chip = { width: 180, height: CHIP_H };
    const tile = previewLayout({ width: 260, height: 92 }, chip);
    near(tile.height, 92);
    assert.equal(tile.start, 1);
    near(tile.compact * tile.height, CHIP_H);
    const row = previewLayout({ width: 190, height: 26 }, chip);
    assert.equal(row.k, 1);
    near(row.start, 26 / CHIP_H);
  });
});

describe('where it hangs', () => {
  const view = { width: 1200, height: 800 };
  const size = { width: 108, height: 110 };

  test('below and to the right of the pointer, clear of what the pointer is over', () => {
    assert.deepEqual(hangAt({ x: 300, y: 200 }, size, view), { x: 300 + HANG.x, y: 200 + HANG.y, flipX: false, flipY: false });
  });

  test('to the left near the right edge, above near the bottom', () => {
    const r = hangAt({ x: 1150, y: 760 }, size, view);
    assert.equal(r.flipX, true);
    assert.equal(r.x, 1150 - HANG.x - size.width);
    assert.equal(r.flipY, true);
    assert.equal(r.y, 760 - HANG.y - size.height);
    assert.ok(r.x + size.width <= view.width - MARGIN);
  });

  test('a window too small for either side keeps the usual side rather than going off the other', () => {
    const r = hangAt({ x: 60, y: 60 }, { width: 108, height: 110 }, { width: 150, height: 150 });
    assert.equal(r.flipX, false);
    assert.equal(r.flipY, false);
  });

  // The folder tree: a column 220 wide down the side of the window.
  const tree = { left: 16, top: 60, right: 236, bottom: 800 };

  test('in the folder tree it hangs beside the tree, not over the folders below the pointer', () => {
    const r = hangAt({ x: 80, y: 300 }, size, view, { lane: tree });
    assert.equal(r.x, tree.right + HANG.x);
    assert.equal(r.y, 300 + HANG.y);
    assert.equal(r.flipX, false);
  });

  test('outside the tree, or with no room beside it, it hangs as usual', () => {
    assert.deepEqual(hangAt({ x: 500, y: 300 }, size, view, { lane: tree }), hangAt({ x: 500, y: 300 }, size, view));
    const narrow = { width: 300, height: 800 };
    assert.equal(hangAt({ x: 80, y: 300 }, size, narrow, { lane: tree }).x, 80 + HANG.x);
  });

  test('a strip that is wider than tall (the tree as chips on a phone) is not a column to hang beside', () => {
    const strip = { left: 0, top: 60, right: 390, bottom: 110 };
    assert.equal(hangAt({ x: 80, y: 80 }, size, view, { lane: strip }).x, 80 + HANG.x);
  });
});

describe('the springs', () => {
  test('each comes to rest on its target, however the frames fall', () => {
    for (const [name, cfg] of Object.entries(SPRINGS)) {
      const s = { p: 0, v: 0 };
      // Uneven frames, one of them a long stall.
      const frames = [16, 17, 16, 250, 16, 33, 16, ...Array(120).fill(16)];
      for (const ms of frames) stepSpring(s, 100, ms / 1000, cfg);
      assert.ok(atRest(s, 100), `${name} at ${s.p}, moving ${s.v}`);
    }
  });

  test('the position lags behind a moving target, never jumps to it', () => {
    const s = { p: 0, v: 0 };
    stepSpring(s, 100, 1 / 60, SPRINGS.move);
    assert.ok(s.p > 0 && s.p < 50, `moved ${s.p} in one frame`);
  });

  test('the position spring barely overshoots; the scale overshoots a touch as it shrinks', () => {
    const peak = (cfg, from, to) => {
      const s = { p: from, v: 0 };
      let lo = from;
      for (let i = 0; i < 120; i++) { stepSpring(s, to, 1 / 60, cfg); lo = Math.min(lo, s.p); }
      return lo;
    };
    assert.ok(peak(SPRINGS.move, 100, 0) > -3, 'position overshoots');
    const scale = peak(SPRINGS.scale, 1, 0.45);
    assert.ok(scale < 0.45 && scale > 0.4, `scale dips to ${scale}`);
  });

  test('a frame of nothing, or a negative one, changes nothing', () => {
    const s = { p: 5, v: 2 };
    stepSpring(s, 100, 0, SPRINGS.move);
    stepSpring(s, 100, -1, SPRINGS.move);
    assert.deepEqual(s, { p: 5, v: 2 });
  });
});

describe('the sway', () => {
  test('at rest it leans a little, away from the pointer', () => {
    assert.equal(swayFor(0), SWAY.rest);
    assert.equal(swayFor(0, true), -SWAY.rest);
  });

  test('moving right it swings one way, left the other, and never past the most', () => {
    assert.ok(swayFor(400) > SWAY.rest);
    assert.ok(swayFor(-400) < SWAY.rest);
    assert.equal(swayFor(1e6), SWAY.rest + SWAY.max);
    assert.equal(swayFor(-1e6), SWAY.rest - SWAY.max);
    assert.equal(swayFor(NaN), SWAY.rest);
  });
});

describe('where a drop may go', () => {
  const rows = [
    { id: 1, folder: 'Footage', can: { edit: true } },
    { id: 2, folder: 'Footage', can: { edit: true } },
    { id: 3, folder: 'Stills', can: { edit: false } },
    { id: 4, folder: '', can: { edit: true } },
  ];
  const at = (path, more = {}) => ({ path, writable: true, pane: false, sprung: false, spring: true, ...more });

  test('files go into any other folder, the top included', () => {
    const d = describeFiles([1, 2], rows);
    assert.equal(classifyDrop(d, at('Stills')), 'ok');
    assert.equal(classifyDrop(d, at('')), 'ok');
    assert.equal(classifyDrop(d, at('Footage/Day 1')), 'ok');
  });

  test('files already in that folder: it is where they are', () => {
    assert.equal(classifyDrop(describeFiles([1, 2], rows), at('Footage')), 'same');
    assert.equal(classifyDrop(describeFiles([4], rows), at('')), 'same');
  });

  test('files from several folders may go into one of them: the others move', () => {
    assert.equal(classifyDrop(describeFiles([1, 4], rows), at('Footage')), 'ok');
  });

  test('a row the page no longer has is not assumed to be there already', () => {
    const d = describeFiles([1, 99], rows);
    assert.equal(d.folders.has(null), true);
    assert.equal(classifyDrop(d, at('Footage')), 'ok');
  });

  test('files none of which may be moved go nowhere; one that may is enough', () => {
    assert.equal(describeFiles([3], rows).editable, false);
    assert.equal(classifyDrop(describeFiles([3], rows), at('Footage')), 'locked');
    assert.equal(classifyDrop(describeFiles([3, 1], rows), at('Stills/x')), 'ok');
  });

  test('a row without the server’s answer counts as movable', () => {
    assert.equal(describeFiles([7], [{ id: 7, folder: 'A' }]).editable, true);
  });

  test('a folder that may not be written takes nothing', () => {
    assert.equal(classifyDrop(describeFiles([1], rows), at('Stills', { writable: false })), 'locked');
    assert.equal(classifyDrop({ kind: 'folder', path: 'A/B' }, at('C', { writable: false })), 'locked');
  });

  test('a folder goes anywhere but onto itself, into itself, or where it is', () => {
    const d = { kind: 'folder', path: 'Projects/2024' };
    assert.equal(classifyDrop(d, at('Archive')), 'ok');
    assert.equal(classifyDrop(d, at('')), 'ok');
    assert.equal(classifyDrop(d, at('Projects/2023')), 'ok');
    assert.equal(classifyDrop(d, at('Projects/2024')), 'self');
    assert.equal(classifyDrop(d, at('Projects/2024/Q1')), 'self');
    assert.equal(classifyDrop(d, at('Projects')), 'same');
  });

  test('a folder whose name merely starts the same is a different folder', () => {
    assert.equal(classifyDrop({ kind: 'folder', path: 'Projects/2024' }, at('Projects/2024 old')), 'ok');
  });

  test('the page around the folders is a place to drop only in a folder the drag has sprung open', () => {
    const d = describeFiles([1], rows);
    assert.equal(classifyDrop(d, at('Stills', { pane: true, sprung: false })), 'none');
    assert.equal(classifyDrop(d, at('Stills', { pane: true, sprung: true })), 'ok');
    // Sprung back into the folder it came from: it is there already.
    assert.equal(classifyDrop(d, at('Footage', { pane: true, sprung: true })), 'same');
  });

  test('nothing dragged, or no folder under the pointer, is nowhere', () => {
    assert.equal(classifyDrop(null, at('A')), 'none');
    assert.equal(classifyDrop(describeFiles([1], rows), null), 'none');
    assert.equal(classifyDrop(describeFiles([1], rows), { path: undefined }), 'none');
  });

  test('what the verdicts mean for the drop and for the thumbnail', () => {
    assert.equal(isDroppable('ok'), true);
    for (const v of ['same', 'self', 'locked', 'none']) assert.equal(isDroppable(v), false, v);
    for (const v of ['same', 'self', 'locked']) assert.equal(isRefused(v), true, v);
    for (const v of ['ok', 'none']) assert.equal(isRefused(v), false, v);
  });
});

describe('which folders spring open', () => {
  const t = (path, more = {}) => ({ path, spring: true, pane: false, ...more });

  test('a folder it could go into, and the folder it came from', () => {
    assert.equal(springsOpen('ok', t('Archive'), 'Footage'), true);
    assert.equal(springsOpen('same', t('Footage'), 'Archive'), true);
  });

  test('never the dragged folder or one inside it, nor a folder that may not be written', () => {
    assert.equal(springsOpen('self', t('Projects/2024'), ''), false);
    assert.equal(springsOpen('locked', t('Archive'), ''), false);
    assert.equal(springsOpen('none', t('Archive'), ''), false);
  });

  test('not the folder already open, a crumb, or the page', () => {
    assert.equal(springsOpen('ok', t('Archive'), 'Archive'), false);
    assert.equal(springsOpen('ok', t('Archive', { spring: false }), ''), false);
    assert.equal(springsOpen('ok', t('Archive', { pane: true }), ''), false);
    assert.equal(springsOpen('ok', null, ''), false);
  });
});
