// Editing metadata from the list: what a patch may carry, and what adding a
// field to the schema may produce.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSchema, validateMetadataPatch, addMetadataField, fileFacetValues,
} from '../lib/dam.js';

const schema = normalizeSchema(null);

test('a patch keeps known fields, coerced to their type', () => {
  assert.deepEqual(
    validateMetadataPatch({ author: ' Ada ', project: ['a', 'a', ' b '], nope: 'x', web_expiration: '2026-01-01' }, schema),
    { author: 'Ada', project: ['a', 'b'], web_expiration: '2026-01-01' },
  );
  assert.deepEqual(validateMetadataPatch({ width: '640', height: 400 }, schema), { width: 640, height: 400 });
  assert.deepEqual(validateMetadataPatch(['author'], schema), {});
});

test('an empty value clears the field instead of being ignored', () => {
  // updateFile merges, so a skipped empty left the old value in place and a
  // set field could never be emptied again.
  assert.deepEqual(
    validateMetadataPatch({ author: '', source: null, project: [], subject: ['  '] }, schema),
    { author: null, source: null, project: null, subject: null },
  );
  // And a cleared field reads as empty wherever values are counted.
  const values = fileFacetValues({ metadata: { author: null, project: null } }, schema);
  assert.deepEqual(values.author, []);
  assert.deepEqual(values.project, []);
});

test('adding a field derives its key from the label and appends it', () => {
  const { schema: next, field, error } = addMetadataField(schema, { label: 'Client name', type: 'select', options: 'Acme, Globex, Acme' });
  assert.equal(error, undefined);
  assert.deepEqual(field, { key: 'client_name', label: 'Client name', type: 'select', ai: false, group: undefined, options: ['Acme', 'Globex'] });
  assert.equal(next.fields.length, schema.fields.length + 1);
  assert.equal(next.fields.at(-1).key, 'client_name');
});

test('a field that would collide or say nothing is refused', () => {
  assert.match(addMetadataField(schema, { label: '' }).error, /name/);
  assert.match(addMetadataField(schema, { label: '!!!' }).error, /letter or number/);
  assert.match(addMetadataField(schema, { label: 'Author' }).error, /already exists/);
  // Keys the facet rail already uses for something else.
  assert.match(addMetadataField(schema, { label: 'Format' }).error, /already exists/);
  assert.match(addMetadataField(schema, { label: 'Tags' }).error, /already exists/);
  assert.match(addMetadataField(schema, { label: 'Region', type: 'color' }).error, /type/);
});
