// Tests for the file listing query builder.
//
// These matter more than their size suggests: this module decides who can see
// which files. The rules used to run in JavaScript over an already-loaded
// table, where they were at least readable; now they are SQL text, where a
// mistake is silent and total. Building the query as a pure function is what
// makes them checkable at all.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFileQuery, nextCursor, sortSpec, encodeCursor, decodeCursor,
} from '../lib/file-query.js';

const admin = { isAdmin: true };
const viewer = { isAdmin: false, email: 'someone@example.com', roleId: 'member', folderGrants: [] };

/** Every `$n` referenced by the SQL, in order of first appearance. */
const placeholders = (text) => [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));

describe('parameter binding', () => {
  test('every placeholder has a parameter, and every parameter is used', () => {
    const { text, params } = buildFileQuery({
      opts: { folder: 'Projects', kind: ['image', 'video'], tags: ['hero'], q: 'sunset', limit: 50 },
      principal: viewer,
    });
    const used = new Set(placeholders(text));
    for (const n of used) {
      assert.ok(n >= 1 && n <= params.length, `$${n} has no parameter (params: ${params.length})`);
    }
    for (let i = 1; i <= params.length; i++) {
      assert.ok(used.has(i), `param $${i} is bound but never referenced`);
    }
  });

  test('placeholders are numbered without gaps or repeats in the listing', () => {
    const { text, params } = buildFileQuery({ opts: { q: 'a', tags: ['b'] }, principal: viewer });
    const nums = placeholders(text);
    const max = Math.max(...nums);
    assert.equal(max, params.length, 'highest placeholder should equal parameter count');
  });

  test('the count query binds its own parameters, independently of the listing', () => {
    // The two share filter-building but not the array; reusing the listing's
    // params for the count would bind the wrong values once a cursor is added.
    const { countText, countParams } = buildFileQuery({
      opts: { folder: 'A', cursor: { value: 5, id: 'x' } },
      principal: viewer,
    });
    for (const n of placeholders(countText)) {
      assert.ok(n <= countParams.length, `count $${n} unbound`);
    }
    assert.ok(!/ORDER BY/.test(countText), 'count should not order');
    assert.ok(!/LIMIT/.test(countText), 'count should not limit');
  });
});

describe('access control', () => {
  test('an admin gets no access predicate at all', () => {
    const { text } = buildFileQuery({ opts: {}, principal: admin });
    assert.ok(!text.includes('file_acl'), 'admin query should not join the ACL table');
    assert.ok(!text.includes("visibility = 'org'"));
  });

  test('a non-admin always gets an access predicate', () => {
    const { text } = buildFileQuery({ opts: {}, principal: viewer });
    assert.ok(text.includes('file_acl'), 'ACL check missing');
    assert.ok(text.includes("f.visibility = 'org'"), 'org visibility check missing');
    assert.ok(text.includes('created_by'), 'ownership check missing');
  });

  test('a principal with no email still gets a restrictive predicate', () => {
    // An anonymous or malformed principal must not accidentally widen access.
    // The empty string matches no created_by, so only org-visible files pass.
    const { text, params } = buildFileQuery({ opts: {}, principal: { isAdmin: false } });
    assert.ok(text.includes('file_acl'));
    assert.ok(params.includes(''), 'expected an empty-string email parameter');
  });

  test('isAdmin is not inferred from a missing principal', () => {
    // buildFileQuery({}) with no principal must be treated as untrusted.
    const { text } = buildFileQuery({});
    assert.ok(text.includes('file_acl'), 'absent principal must not be treated as admin');
  });

  test('folder grants are only added when present', () => {
    const without = buildFileQuery({ opts: {}, principal: viewer });
    assert.ok(!without.text.includes('unnest'), 'no grants should mean no unnest clause');

    const with_ = buildFileQuery({
      opts: {},
      principal: { ...viewer, folderGrants: ['Clients/Acme'] },
    });
    assert.ok(with_.text.includes('unnest'), 'grants should produce an unnest clause');
    assert.ok(with_.params.some((p) => Array.isArray(p) && p.includes('Clients/Acme')));
  });

  test('a grant on a folder covers its descendants but not its siblings', () => {
    const { text } = buildFileQuery({
      opts: {},
      principal: { ...viewer, folderGrants: ['Clients'] },
    });
    // The predicate must anchor on a separator. `folder LIKE gf || '%'` would
    // let a grant on "Clients" also expose "ClientsPrivate".
    assert.ok(text.includes("f.folder LIKE gf || '/%'"), 'descendant match must anchor on /');
    assert.ok(text.includes('f.folder = gf'), 'exact folder match missing');
  });

  test("a grant on '' means the whole library", () => {
    const { text } = buildFileQuery({ opts: {}, principal: { ...viewer, folderGrants: [''] } });
    assert.ok(text.includes("gf = ''"), 'root grant should short-circuit to everything');
  });
});

describe('filters', () => {
  test('trash is excluded by default and required when asked for', () => {
    assert.ok(buildFileQuery({ opts: {}, principal: admin }).text.includes('f.deleted_at IS NULL'));
    assert.ok(buildFileQuery({ opts: { trashed: true }, principal: admin }).text.includes('f.deleted_at IS NOT NULL'));
  });

  test('thumbnail and system artifacts are excluded', () => {
    const { text, params } = buildFileQuery({ opts: {}, principal: admin });
    assert.ok(text.includes('NOT EXISTS (SELECT 1 FROM files t'), 'legacy thumbnail check missing');
    assert.ok(params.some((p) => typeof p === 'string' && p.includes('_thumbs/')));
    assert.ok(params.some((p) => typeof p === 'string' && p.includes('DS_Store')));
  });

  test('artifact matching uses regex, not LIKE', () => {
    // `LIKE '_thumbs/%'` would match `Xthumbs/...` because `_` is a LIKE
    // wildcard. Regexes treat it literally.
    const { text } = buildFileQuery({ opts: {}, principal: admin });
    assert.ok(text.includes('!~'), 'expected a regex non-match operator');
  });

  test('a folder prefix matches the folder and its descendants only', () => {
    const { text, params } = buildFileQuery({ opts: { folderPrefix: 'A' }, principal: admin });
    assert.ok(text.includes('f.folder = $'), 'exact match missing');
    assert.ok(params.includes('A/%'), 'descendant pattern missing');
    assert.ok(!params.includes('A%'), 'must not match sibling folders by bare prefix');
  });

  test('an empty folder prefix adds no folder predicate', () => {
    const { text } = buildFileQuery({ opts: { folderPrefix: '' }, principal: admin });
    assert.ok(!text.includes('f.folder ='), 'root prefix should not constrain folder');
  });

  test('an exact folder of "" is honoured and is not confused with a prefix', () => {
    // Files at the library root live in folder ''. `opts.folder = ''` must
    // still produce an equality predicate — falsy is not the same as absent.
    const { text, params } = buildFileQuery({ opts: { folder: '' }, principal: admin });
    assert.ok(text.includes('f.folder = $'), 'empty folder should still filter');
    assert.ok(params.includes(''));
  });

  test('a filespace prefix constrains storage_key with a separator anchor', () => {
    const { params } = buildFileQuery({ opts: { storagePrefix: 'clients/acme' }, principal: admin });
    assert.ok(params.includes('clients/acme'));
    assert.ok(params.includes('clients/acme/%'));
  });

  test('tags use containment, not the key-existence operators', () => {
    // The GIN index on tags is jsonb_path_ops, which supports only `@>`.
    // `?&` parses fine and then sequentially scans the table.
    const all = buildFileQuery({ opts: { tags: ['a', 'b'] }, principal: admin });
    assert.ok(all.text.includes('@>'), 'expected containment');
    assert.ok(!all.text.includes('?&') && !all.text.includes('?|'), 'must not use key-existence ops');
  });

  test('tag mode all is one containment; any is an OR of containments', () => {
    const all = buildFileQuery({ opts: { tags: ['a', 'b'], tagMode: 'all' }, principal: admin });
    assert.equal((all.text.match(/@>/g) || []).length, 1);
    assert.ok(all.params.some((p) => p === '["a","b"]'));

    const any = buildFileQuery({ opts: { tags: ['a', 'b'], tagMode: 'any' }, principal: admin });
    assert.equal((any.text.match(/@>/g) || []).length, 2);
  });

  test('tags are lowercased and de-duplicated to match how they are stored', () => {
    const { params } = buildFileQuery({ opts: { tags: ['Hero', 'HERO', ' hero '] }, principal: admin });
    assert.ok(params.some((p) => p === '["hero"]'), `expected one lowercase tag, got ${JSON.stringify(params)}`);
  });

  test('search combines full text with a name substring match', () => {
    const { text, params } = buildFileQuery({ opts: { q: 'sunset' }, principal: admin });
    assert.ok(text.includes('websearch_to_tsquery'), 'full-text search missing');
    assert.ok(text.includes('ILIKE'), 'substring fallback missing — FTS cannot match partial words');
    assert.ok(params.includes('%sunset%'));
  });

  test('a whitespace-only query adds no search predicate', () => {
    const { text } = buildFileQuery({ opts: { q: '   ' }, principal: admin });
    assert.ok(!text.includes('websearch_to_tsquery'));
  });
});

describe('pagination', () => {
  test('the default sort is newest first, with id as a tiebreaker', () => {
    const { text } = buildFileQuery({ opts: {}, principal: admin });
    assert.ok(text.includes('ORDER BY f.created_at DESC, f.id DESC'));
  });

  test('an unknown sort falls back to the default rather than injecting', () => {
    const spec = sortSpec('; DROP TABLE files;--');
    assert.equal(spec.column, 'created_at');
    const { text } = buildFileQuery({ opts: { sort: 'nonsense' }, principal: admin });
    assert.ok(!text.includes('nonsense'), 'unknown sort must not reach the SQL');
  });

  test('sort direction drives the keyset comparison operator', () => {
    const desc = buildFileQuery({ opts: { cursor: { value: 100, id: 'x' } }, principal: admin });
    assert.ok(desc.text.includes('(f.created_at, f.id) < ('), 'DESC should page downward');

    const asc = buildFileQuery({ opts: { sort: 'old', cursor: { value: 100, id: 'x' } }, principal: admin });
    assert.ok(asc.text.includes('(f.created_at, f.id) > ('), 'ASC should page upward');
  });

  test('the keyset uses a row-value comparison so ties cannot duplicate or skip', () => {
    const { text } = buildFileQuery({ opts: { cursor: { value: 1, id: 'a' } }, principal: admin });
    assert.ok(/\(f\.\w+, f\.id\) [<>] \(\$\d+, \$\d+\)/.test(text));
  });

  test('a cursor without an id is ignored', () => {
    const { text } = buildFileQuery({ opts: { cursor: { value: 5 } }, principal: admin });
    assert.ok(!text.includes('(f.created_at, f.id) <'), 'an id-less cursor cannot be ordered against');
  });

  test('limit is clamped to a sane range', () => {
    assert.equal(buildFileQuery({ opts: { limit: 100000 }, principal: admin }).limit, 500);
    assert.equal(buildFileQuery({ opts: { limit: 0 }, principal: admin }).limit, 100);
    assert.equal(buildFileQuery({ opts: { limit: -5 }, principal: admin }).limit, 100);
    assert.equal(buildFileQuery({ opts: { limit: 'abc' }, principal: admin }).limit, 100);
  });

  test('the count excludes the keyset predicate so a total does not shrink while paging', () => {
    const { countText } = buildFileQuery({
      opts: { cursor: { value: 10, id: 'x' } },
      principal: admin,
    });
    assert.ok(!countText.includes('f.id) <'), 'count must not be narrowed by the cursor');
  });
});

describe('cursors', () => {
  test('nextCursor is null when the page is short — that is the end signal', () => {
    const rows = [{ created_at: 1, id: 'a' }];
    assert.equal(nextCursor(rows, { column: 'created_at' }, 100), null);
  });

  test('nextCursor points at the last row of a full page', () => {
    const rows = [{ created_at: 3, id: 'a' }, { created_at: 2, id: 'b' }];
    assert.deepEqual(nextCursor(rows, { column: 'created_at' }, 2), { value: 2, id: 'b' });
  });

  test('nextCursor tolerates a non-array', () => {
    assert.equal(nextCursor(null, { column: 'created_at' }, 10), null);
  });

  test('a cursor round-trips through its encoding', () => {
    const c = { value: 1737000000000, id: 'abc-123' };
    assert.deepEqual(decodeCursor(encodeCursor(c)), c);
  });

  test('a malformed cursor decodes to null rather than throwing', () => {
    // Cursors travel in URLs and get truncated by things we do not control.
    // The correct response is "start from the beginning", not a 500.
    assert.equal(decodeCursor('not-base64!!'), null);
    assert.equal(decodeCursor(''), null);
    assert.equal(decodeCursor(null), null);
    assert.equal(decodeCursor(Buffer.from('{"no":"id"}').toString('base64url')), null);
  });
});
