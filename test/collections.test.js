// Collections' rules (lib/collections.js) and the predicate the listing
// builds from them (lib/file-query.js collectionClause). The SQL itself runs
// against a real database in test/collections-db.test.js.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCollectionInput, normalizeCollection, opsFor, describeRule, collectionVisible, LIMITS,
} from '../lib/collections.js';
import { collectionClause, buildFileQuery } from '../lib/file-query.js';

const schema = {
  fields: [
    { key: 'project', label: 'Project', type: 'multiselect' },
    { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Archived'] },
    { key: 'web_expiration', label: 'Web Expiration', type: 'date' },
  ],
};

describe('what the API accepts', () => {
  test('a collection with rules, cleaned up', () => {
    const v = validateCollectionInput({
      name: '  Spring   launch ',
      match: 'any',
      rules: [
        { field: 'tag', op: 'any', values: ['Hero', 'hero', ' Spring '] },
        { field: 'kind', values: ['image', 'video'] },
        { field: 'meta:project', op: 'none', values: ['Old'] },
        { field: 'meta:web_expiration', op: 'after', values: ['2026-10-01'] },
        { field: 'meta:status', op: 'set' },
      ],
    }, { schema });
    assert.equal(v.error, undefined);
    assert.equal(v.value.name, 'Spring launch');
    assert.equal(v.value.driveId, '', 'All Files when no drive is named');
    assert.equal(v.value.match, 'any');
    assert.deepEqual(v.value.rules[0], { field: 'tag', op: 'any', values: ['hero', 'spring'] }, 'tags in lower case, once each');
    assert.deepEqual(v.value.rules[1], { field: 'kind', op: 'any', values: ['image', 'video'] }, 'op defaults to any');
    assert.deepEqual(v.value.rules[4], { field: 'meta:status', op: 'set', values: [] });
  });

  test('says what is wrong', () => {
    const err = (body, opts = { schema }) => validateCollectionInput(body, opts).error;
    assert.match(err({ rules: [{ field: 'tag', values: ['a'] }] }), /name/);
    assert.match(err({ name: 'x', rules: [] }), /at least one rule/);
    assert.match(err({ name: 'x', match: 'some', rules: [{ field: 'tag', values: ['a'] }] }), /all.*any/);
    assert.match(err({ name: 'x', rules: [{ field: 'meta:nope', values: ['a'] }] }), /no metadata field "nope"/);
    assert.match(err({ name: 'x', rules: [{ field: 'kind', values: ['pdf'] }] }), /kinds are/);
    assert.match(err({ name: 'x', rules: [{ field: 'kind', op: 'set' }] }), /does not apply/);
    assert.match(err({ name: 'x', rules: [{ field: 'meta:status', op: 'before', values: ['2026-01-01'] }] }), /does not apply/, 'dates only');
    assert.match(err({ name: 'x', rules: [{ field: 'meta:web_expiration', op: 'before', values: ['soon'] }] }), /YYYY-MM-DD/);
    assert.match(err({ name: 'x', rules: [{ field: 'tag', values: [] }] }), /at least one value/);
    assert.match(err({ name: 'x', rules: [{ field: 'tag', values: ['a'] }], owner: 'me' }), /not part of a collection/);
    assert.match(err({ name: 'x', rules: Array(LIMITS.rules + 1).fill({ field: 'tag', values: ['a'] }) }), /at most/);
    assert.match(err({ driveId: 'd1' }, { partial: true }), /stays in the drive/);
  });

  test('a PATCH keeps what it does not send', () => {
    const v = validateCollectionInput({ match: 'all' }, { partial: true, schema });
    assert.deepEqual(v.value, { match: 'all' });
  });

  test('dates compare; kinds do not', () => {
    assert.ok(opsFor('meta:web_expiration', schema).includes('before'));
    assert.ok(!opsFor('meta:project', schema).includes('before'));
    assert.deepEqual(opsFor('kind'), ['any', 'none']);
  });
});

describe('reading what is stored', () => {
  test('drops what it does not recognise', () => {
    const c = normalizeCollection({
      match: 'whatever',
      rules: [
        { field: 'tag', op: 'any', values: ['A'] },
        { field: 'bogus', values: ['x'] },
        { field: 'kind', values: ['image', 'pdf'] },
        { field: 'meta:x', op: 'before', values: ['not a day'] },
        { field: 'tag', op: 'any', values: [] },
      ],
    });
    assert.equal(c.match, 'all');
    assert.deepEqual(c.rules, [
      { field: 'tag', op: 'any', values: ['a'] },
      { field: 'kind', op: 'any', values: ['image'] },
    ]);
  });

  test('a rule in words', () => {
    assert.equal(describeRule({ field: 'meta:project', op: 'any', values: ['Spring', 'Summer'] }, schema), 'Project is Spring or Summer');
    assert.equal(describeRule({ field: 'tag', op: 'unset', values: [] }), 'Has no tags');
    assert.equal(describeRule({ field: 'meta:web_expiration', op: 'before', values: ['2026-01-01'] }, schema), 'Web Expiration before 2026-01-01');
  });

  test('visible in All Files to everyone, in a drive to its members', () => {
    assert.ok(collectionVisible({ driveId: '' }, []));
    assert.ok(collectionVisible({ driveId: 'd1' }, [{ id: 'd1' }]));
    assert.ok(!collectionVisible({ driveId: 'd2' }, [{ id: 'd1' }]));
  });
});

describe('the predicate', () => {
  const build = (collection) => {
    const params = [];
    const sql = collectionClause({ collection, push: (v) => `$${params.push(v)}` });
    return { sql, params };
  };

  test('all is AND, any is OR', () => {
    const rules = [{ field: 'kind', op: 'any', values: ['image'] }, { field: 'kind', op: 'none', values: ['video'] }];
    assert.match(build({ match: 'all', rules }).sql, /\n {4}AND /);
    assert.match(build({ match: 'any', rules }).sql, /\n {4}OR /);
  });

  test('no rules match nothing, never everything', () => {
    assert.equal(build({ match: 'all', rules: [] }).sql, 'FALSE');
  });

  test('every value is a parameter', () => {
    const { sql, params } = build({
      match: 'all',
      drivePatterns: ['team/%'],
      rules: [
        { field: 'tag', op: 'any', values: ["o'brien"] },
        { field: 'meta:project', op: 'any', values: ['Spring; DROP TABLE files'] },
        { field: 'meta:web_expiration', op: 'before', values: ['2026-01-01'] },
      ],
    });
    assert.ok(!sql.includes("o'brien") && !sql.includes('DROP TABLE'));
    assert.ok(params.includes('["o\'brien"]'), 'a tag goes in as a containment');
    assert.deepEqual(params[0], ['team/%'], 'the drive patterns first');
    assert.ok(params.includes('project'), 'the metadata key too');
  });

  test('tags and metadata are inherited from folders; kinds are not', () => {
    assert.match(build({ match: 'all', rules: [{ field: 'tag', op: 'any', values: ['a'] }] }).sql, /FROM folders d/);
    assert.match(build({ match: 'all', rules: [{ field: 'meta:project', op: 'set', values: [] }] }).sql, /FROM folders d/);
    assert.doesNotMatch(build({ match: 'all', rules: [{ field: 'kind', op: 'any', values: ['image'] }] }).sql, /folders/);
  });

  test('none and not-set are the negation of the whole, inheritance included', () => {
    const { sql } = build({ match: 'all', rules: [{ field: 'tag', op: 'none', values: ['a'] }] });
    assert.match(sql, /^\(NOT \(/);
  });

  test('it narrows the listing, and the access clauses still apply', () => {
    const { text } = buildFileQuery({
      opts: { collection: { match: 'all', rules: [{ field: 'kind', op: 'any', values: ['image'] }], drivePatterns: [] } },
      principal: { email: 'a@b.test' },
    });
    assert.match(text, /COALESCE\(f\.kind, 'other'\) = ANY/);
    assert.match(text, /f\.visibility = 'org'/);
  });
});

describe('collections made in All files while there is none (lib/collection-scope.js)', async () => {
  const { principalFrom } = await import('../lib/authz.js');
  const { isStranded, visibleCollections, collectionForClient } = await import('../lib/collection-scope.js');
  const drives = [{ id: 'd1', name: 'Team', role: 'editor' }];
  const lib = { id: 'lib', driveId: '', name: 'Models', match: 'all', rules: [] };
  const inDrive = { id: 'a', driveId: 'd1', name: 'Heroes', match: 'all', rules: [] };
  const who = (over = {}) => principalFrom({ email: 'ed@x.test', globalFlags: {}, grants: { drives, roles: { d1: 'editor' } }, ...over });

  test('stranded with no All files, ordinary with one', () => {
    assert.equal(isStranded(lib, who()), true);
    assert.equal(isStranded(lib, who({ globalFlags: { library: true } })), false);
    assert.equal(isStranded(inDrive, who()), false);
  });

  test('never while the flags are unread: their defaults have no All files, and a live one would be offered to move', () => {
    const admin = principalFrom({ email: 'boss@x.test', isAdmin: true, globalFlags: null, degraded: true });
    assert.equal(admin.degraded, true);
    assert.equal(isStranded(lib, admin), false);
    assert.equal(visibleCollections([lib, inDrive], admin, [{ id: 'd1', name: 'Team', role: 'owner' }], { stranded: true }).some((c) => c.stranded), false);
  });

  test('listed only when asked for, only to whoever may edit files, and marked', () => {
    assert.deepEqual(visibleCollections([lib, inDrive], who(), drives).map((c) => c.id), ['a']);
    const asked = visibleCollections([lib, inDrive], who(), drives, { stranded: true });
    assert.deepEqual(asked.map((c) => [c.id, !!c.stranded]), [['lib', true], ['a', false]]);
    const viewerRole = who({ person: { roleId: 'viewer' } });
    assert.deepEqual(visibleCollections([lib, inDrive], viewerRole, drives, { stranded: true }).map((c) => c.id), ['a']);
    assert.equal(collectionForClient(lib, who(), drives).canEdit, true);
  });
});
