import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIST_COLUMNS, columnOf, nextSortFor, parseView } from '../lib/list-columns.js';
import { SORT_KEYS } from '../lib/file-query.js';

test('every column maps to sort keys the server knows', () => {
  // An unknown key falls back to Newest on the server, which would read as a
  // header that does nothing.
  for (const c of LIST_COLUMNS) {
    assert.ok(SORT_KEYS.includes(c.asc), `${c.key} asc: ${c.asc}`);
    assert.ok(SORT_KEYS.includes(c.desc), `${c.key} desc: ${c.desc}`);
  }
});

test('a header opens in its natural direction and then flips', () => {
  assert.equal(nextSortFor('name', 'new'), 'name');
  assert.equal(nextSortFor('name', 'name'), 'name_desc');
  assert.equal(nextSortFor('name', 'name_desc'), 'name');
  assert.equal(nextSortFor('size', 'name'), 'size');
  assert.equal(nextSortFor('size', 'size'), 'small');
  assert.equal(nextSortFor('modified', 'old'), 'modified');
  assert.equal(nextSortFor('modified', 'modified'), 'modified_old');
  assert.equal(nextSortFor('type', 'size'), 'type');
  assert.equal(nextSortFor('nope', 'size'), 'size');
});

test('the active column and direction are read back from the sort', () => {
  assert.deepEqual(columnOf('small'), { key: 'size', dir: 'asc' });
  assert.deepEqual(columnOf('type_desc'), { key: 'type', dir: 'desc' });
  assert.equal(columnOf('new'), null, 'created-date sorts have no column');
});

test('a stored view is trusted only when it is one we know', () => {
  assert.equal(parseView('list'), 'list');
  assert.equal(parseView('grid'), 'grid');
  assert.equal(parseView(null), 'grid');
  assert.equal(parseView('columns'), 'grid');
});
