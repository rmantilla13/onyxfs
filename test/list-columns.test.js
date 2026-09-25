import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIST_COLUMNS, columnOf, nextSortFor, parseView,
  availableColumns, parseColumns, resolveColumns, columnTemplate, moveColumn, DEFAULT_COLUMNS,
  columnMinWidth, fitColumns,
} from '../lib/list-columns.js';
import { SORT_KEYS } from '../lib/file-query.js';
import { normalizeSchema } from '../lib/dam.js';

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
  // Newest and Oldest are the Added column, now that there is one to show.
  assert.deepEqual(columnOf('new'), { key: 'added', dir: 'desc' });
  assert.deepEqual(columnOf('old'), { key: 'added', dir: 'asc' });
  assert.equal(columnOf('nope'), null);
});

const schema = normalizeSchema(null);

test('every metadata field is offered as a column, and only with the flag on', () => {
  const all = availableColumns(schema);
  for (const f of schema.fields) {
    const c = all.find((x) => x.key === `meta:${f.key}`);
    assert.ok(c, f.key);
    assert.equal(c.edit, f.type, `${f.key} edits as its field type`);
  }
  assert.ok(!availableColumns(schema, { metadata: false }).some((c) => c.key.startsWith('meta:')));
  // Tags are not part of the schema, so the flag does not take them away.
  assert.ok(availableColumns(schema, { metadata: false }).some((c) => c.key === 'tags'));
});

test('only columns the server can order by are sortable', () => {
  for (const c of availableColumns(schema)) {
    if (!c.asc) continue;
    assert.ok(SORT_KEYS.includes(c.asc) && SORT_KEYS.includes(c.desc), c.key);
  }
  assert.ok(!availableColumns(schema).find((c) => c.key === 'meta:project').asc);
});

test('a stored column choice keeps only columns that still exist', () => {
  const all = availableColumns(schema);
  assert.deepEqual(parseColumns(null, all), DEFAULT_COLUMNS);
  assert.deepEqual(parseColumns('not json', all), DEFAULT_COLUMNS);
  assert.deepEqual(parseColumns('["tags","meta:gone","size","tags"]', all), ['tags', 'size']);
  assert.deepEqual(parseColumns('["meta:gone"]', all), DEFAULT_COLUMNS, 'nothing usable left is the default');
  assert.deepEqual(parseColumns('[]', all), [], 'an empty choice is a choice: just the name');
});

test('columns resolve in order and lay out as grid tracks', () => {
  const cols = resolveColumns(['tags', 'nope', 'size'], availableColumns(schema));
  assert.deepEqual(cols.map((c) => c.key), ['tags', 'size']);
  assert.equal(columnTemplate(cols), '44px minmax(160px, 1fr) minmax(120px, 220px) minmax(64px, 92px) 28px');
});

test('columns that do not fit wait at the end rather than widen the page', () => {
  const cols = resolveColumns(['size', 'modified', 'tags', 'meta:project'], availableColumns(schema));
  const all = columnMinWidth(cols);
  assert.equal(all, 44 + 160 + 28 + (64 + 96 + 120 + 120) + 12 * 6 + 16);
  assert.deepEqual(fitColumns(cols, all).map((c) => c.key), ['size', 'modified', 'tags', 'meta:project']);
  assert.deepEqual(fitColumns(cols, all - 1).map((c) => c.key), ['size', 'modified', 'tags']);
  assert.deepEqual(fitColumns(cols, 300), [], 'too narrow for any column: just the name');
  assert.deepEqual(fitColumns(cols, 0).length, 4, 'not measured yet: all of them');
});

test('a column moves one place and stops at either end', () => {
  assert.deepEqual(moveColumn(['a', 'b', 'c'], 'c', -1), ['a', 'c', 'b']);
  assert.deepEqual(moveColumn(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
  assert.deepEqual(moveColumn(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c']);
  assert.deepEqual(moveColumn(['a', 'b'], 'x', 1), ['a', 'b']);
});

test('a stored view is trusted only when it is one we know', () => {
  assert.equal(parseView('list'), 'list');
  assert.equal(parseView('grid'), 'grid');
  assert.equal(parseView(null), 'grid');
  assert.equal(parseView('columns'), 'grid');
});
