// Finder's selection rules: click, ⌘-click, ⇧-click, ⌘⇧-click, arrows,
// ⇧-arrows and ⇧Space, over files and folders in one view order.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  fileKey, folderKey, parseKey, emptySelection, rangeKeys, clickSelect, moveTo, toggleKey,
  splitKeys, joinKeys, sameMembers, selectKeys,
} from '../lib/selection.js';

const order = ['d:A', 'd:B', 'f:1', 'f:2', 'f:3', 'f:4', 'f:5'];
const keys = (s) => [...s.keys].sort();

describe('keys', () => {
  test('files and folders have their own prefix, and parse back', () => {
    assert.equal(fileKey('abc'), 'f:abc');
    assert.equal(folderKey('a/b'), 'd:a/b');
    assert.deepEqual(parseKey('f:abc'), { type: 'file', id: 'abc' });
    assert.deepEqual(parseKey('d:a/b:c'), { type: 'folder', id: 'a/b:c' });
    assert.deepEqual(parseKey('d:'), { type: 'folder', id: '' });
    assert.equal(parseKey('x:1'), null);
    assert.equal(parseKey(null), null);
  });

  test('split and join are inverses, folders first', () => {
    const { files, folders } = splitKeys(new Set(['f:1', 'd:A', 'f:2', 'junk']));
    assert.deepEqual([...files], ['1', '2']);
    assert.deepEqual([...folders], ['A']);
    assert.deepEqual([...joinKeys(files, folders)], ['d:A', 'f:1', 'f:2']);
  });
});

describe('rangeKeys', () => {
  test('inclusive, whichever end comes first', () => {
    assert.deepEqual(rangeKeys(order, 'f:1', 'f:3'), ['f:1', 'f:2', 'f:3']);
    assert.deepEqual(rangeKeys(order, 'f:3', 'd:B'), ['d:B', 'f:1', 'f:2', 'f:3']);
    assert.deepEqual(rangeKeys(order, 'f:2', 'f:2'), ['f:2']);
  });
  test('an anchor that is not on screen makes the range just the target', () => {
    assert.deepEqual(rangeKeys(order, 'f:gone', 'f:3'), ['f:3']);
    assert.deepEqual(rangeKeys(order, null, 'f:3'), ['f:3']);
  });
  test('a target that is not on screen is no range at all', () => {
    assert.deepEqual(rangeKeys(order, 'f:1', 'f:gone'), []);
  });
});

describe('clickSelect', () => {
  test('a plain click selects the item alone and anchors there', () => {
    let s = clickSelect(emptySelection(), 'f:2', { order });
    s = clickSelect(s, 'f:4', { order });
    assert.deepEqual(keys(s), ['f:4']);
    assert.equal(s.anchor, 'f:4');
    assert.equal(s.focus, 'f:4');
  });

  test('a plain click on a member of a multi-selection collapses it to that item', () => {
    const s = clickSelect(selectKeys(['f:1', 'f:2', 'f:3']), 'f:2', { order });
    assert.deepEqual(keys(s), ['f:2']);
  });

  test('⌘-click flips the item, keeps the rest, and moves the anchor', () => {
    let s = clickSelect(emptySelection(), 'f:1', { order });
    s = clickSelect(s, 'f:3', { toggle: true, order });
    assert.deepEqual(keys(s), ['f:1', 'f:3']);
    assert.equal(s.anchor, 'f:3');
    s = clickSelect(s, 'f:1', { toggle: true, order });
    assert.deepEqual(keys(s), ['f:3']);
    assert.equal(s.anchor, 'f:1', 'the anchor is where the last ⌘-click was, even a deselect');
  });

  test('⇧-click replaces the selection with anchor..item', () => {
    let s = clickSelect(emptySelection(), 'f:2', { order });
    s = clickSelect(s, 'f:5', { toggle: true, order }); // anchor f:5, {2,5}
    s = clickSelect(s, 'f:3', { range: true, order });
    assert.deepEqual(keys(s), ['f:3', 'f:4', 'f:5']);
    assert.equal(s.anchor, 'f:5', 'a range keeps its anchor');
    assert.equal(s.focus, 'f:3');
    // A second ⇧-click re-spans from the same anchor.
    s = clickSelect(s, 'f:1', { range: true, order });
    assert.deepEqual(keys(s), ['f:1', 'f:2', 'f:3', 'f:4', 'f:5']);
  });

  test('⌘⇧-click adds anchor..item to the rest', () => {
    let s = clickSelect(emptySelection(), 'd:A', { order });
    s = clickSelect(s, 'f:3', { toggle: true, order }); // anchor f:3
    s = clickSelect(s, 'f:5', { toggle: true, range: true, order });
    assert.deepEqual(keys(s), ['d:A', 'f:3', 'f:4', 'f:5']);
  });

  test('⇧-click with no anchor selects just the item and anchors there', () => {
    const s = clickSelect(emptySelection(), 'f:4', { range: true, order });
    assert.deepEqual(keys(s), ['f:4']);
    assert.equal(s.anchor, 'f:4');
  });

  test('folders and files are one selection', () => {
    let s = clickSelect(emptySelection(), 'd:B', { order });
    s = clickSelect(s, 'f:2', { range: true, order });
    assert.deepEqual(keys(s), ['d:B', 'f:1', 'f:2']);
  });
});

describe('moveTo and toggleKey', () => {
  test('an arrow moves the selection with the focus', () => {
    const s = moveTo(selectKeys(['f:1', 'f:2']), 'f:3', { order });
    assert.deepEqual(keys(s), ['f:3']);
    assert.equal(s.anchor, 'f:3');
  });

  test('⇧-arrow extends from the anchor, and back again shrinks it', () => {
    let s = clickSelect(emptySelection(), 'f:2', { order });
    s = moveTo(s, 'f:3', { extend: true, order });
    s = moveTo(s, 'f:4', { extend: true, order });
    assert.deepEqual(keys(s), ['f:2', 'f:3', 'f:4']);
    s = moveTo(s, 'f:3', { extend: true, order });
    assert.deepEqual(keys(s), ['f:2', 'f:3']);
    s = moveTo(s, 'f:1', { extend: true, order });
    assert.deepEqual(keys(s), ['f:1', 'f:2']);
    assert.equal(s.anchor, 'f:2');
  });

  test('⇧-arrow with nothing selected starts from where it is', () => {
    const s = moveTo(emptySelection(), 'f:1', { extend: true, order });
    assert.deepEqual(keys(s), ['f:1']);
  });

  test('⇧Space flips the focused item', () => {
    let s = clickSelect(emptySelection(), 'f:1', { order });
    s = toggleKey(s, 'f:3');
    assert.deepEqual(keys(s), ['f:1', 'f:3']);
    s = toggleKey(s, 'f:3');
    assert.deepEqual(keys(s), ['f:1']);
  });
});

test('sameMembers', () => {
  assert.ok(sameMembers(new Set([1, 2]), new Set([2, 1])));
  assert.ok(!sameMembers(new Set([1, 2]), new Set([1])));
  assert.ok(!sameMembers(new Set([1, 2]), new Set([1, 3])));
});
