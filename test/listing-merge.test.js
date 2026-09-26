// A refreshed first page folded into a deep listing during an upload batch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeFirstPage, keepUnchanged } from '../lib/listing-merge.js';

const row = (id, extra = {}) => ({ id, name: id, version: 1, seq: 1, ...extra });
const ids = (list) => list.map((f) => f.id);

test('new rows arrive at the top and every loaded page stays', () => {
  const loaded = { files: ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => row(x)), cursor: 'after-f' };
  const page = { files: ['n1', 'n2', 'a', 'b'].map((x) => row(x)), cursor: 'after-b' };
  const out = mergeFirstPage(loaded, page);
  assert.deepEqual(ids(out.files), ['n1', 'n2', 'a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(out.cursor, 'after-f', 'the end of what is loaded is still the end');
});

test('a row pushed off the first page by new ones is kept, in order', () => {
  const loaded = { files: ['a', 'b', 'c'].map((x) => row(x)), cursor: 'after-c' };
  const page = { files: ['n1', 'a', 'b'].map((x) => row(x)), cursor: 'after-b' };
  assert.deepEqual(ids(mergeFirstPage(loaded, page).files), ['n1', 'a', 'b', 'c']);
});

test('a row the page has changed is the page’s version, once', () => {
  const loaded = { files: [row('a'), row('b')], cursor: null };
  const page = { files: [row('a', { name: 'renamed', version: 2 })], cursor: null };
  const out = mergeFirstPage(loaded, page);
  assert.deepEqual(ids(out.files), ['a', 'b']);
  assert.equal(out.files[0].name, 'renamed');
});

test('nothing loaded beyond the page: the page and its cursor', () => {
  const loaded = { files: [row('a')], cursor: 'x' };
  const page = { files: [row('n1'), row('a')], cursor: 'after-a' };
  assert.deepEqual(mergeFirstPage(loaded, page), { files: page.files, cursor: 'after-a' });
  assert.deepEqual(mergeFirstPage(null, page), { files: page.files, cursor: 'after-a' });
});

test('unchanged rows keep their object, so a memoized card does not re-render', () => {
  const a = row('a');
  const b = row('b', { thumbnailUrl: 't1' });
  const next = keepUnchanged([a, b], [row('a'), row('b', { thumbnailUrl: 't2', seq: 2 }), row('c')]);
  assert.equal(next[0], a);
  assert.notEqual(next[1], b);
  assert.equal(next[1].thumbnailUrl, 't2');
  assert.equal(next[2].id, 'c');
});
