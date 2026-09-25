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
  buildFileQuery, buildFolderCountQuery, artifactClauses, nextCursor, sortSpec, encodeCursor, decodeCursor, SORT_KEYS,
} from '../lib/file-query.js';
import { drivePatterns } from '../lib/drive-access.js';

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
    assert.ok(text.includes("starts_with(f.folder, gf || '/')"), 'descendant match must anchor on /');
    assert.ok(text.includes('f.folder = gf'), 'exact folder match missing');
    // And it must not be LIKE at all: folder names hold `_` and `%`, which
    // LIKE reads as wildcards, so a grant on "Q1_2024" reached "Q1-2024/…".
    assert.ok(!/f\.folder LIKE gf/.test(text), 'a grant is a name, not a pattern');
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

describe('artifact hints', () => {
  // Each artifact regex runs only for keys that first match one of its LIKE
  // hints (artifactClauses). A hint that missed a key its regex matches would
  // let that thumbnail or .DS_Store into every listing, so the rule is checked
  // with the patterns the SQL actually binds.
  const bound = [];
  const pairs = artifactClauses((v) => `$${bound.push(v)}`)
    .filter((clause) => clause.includes('!~'))
    .map((clause) => {
      const values = placeholders(clause).map((n) => bound[n - 1]);
      return { clause, hints: values.slice(0, -1), re: values.at(-1) };
    });

  /** A LIKE pattern as an anchored RegExp: % is any run, _ any one character. */
  const like = (p) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 's');
  const hinted = (hints, key) => hints.some((h) => like(h).test(key));

  const dirs = ['', 'a/', 'files/Clients/Acme/', 'brand/2026/'];
  const names = [
    // artifacts
    '_thumbs/0f8f.webp', 'IMG-thumb-1.jpg', 'x-thumb-y.jpeg', 'x-thumb-y.png', 'x-thumb-.webp',
    '.DS_Store', '.localized', 'Thumbs.db', 'desktop.ini', '._IMG_0001.JPG', '._',
    // near misses
    'x-thumb-y.gif', 'thumbnail.png', 'my_thumbs/a.jpg', 'Xthumbs/a.jpg', 'X-THUMB-Y.PNG',
    'Thumbs.db.bak', 'xdesktop.ini', 'my.DS_Store.mov', '.hidden/ok.txt', 'a.txt', '',
  ];
  const keys = dirs.flatMap((d) => names.map((n) => d + n));

  test('one hinted regex for thumbnails and one for OS junk, the hint tried first', () => {
    assert.equal(pairs.length, 2);
    for (const { clause, hints, re } of pairs) {
      assert.ok(hints.length && hints.every((h) => typeof h === 'string') && typeof re === 'string', clause);
      assert.ok(clause.indexOf('NOT LIKE') < clause.indexOf('!~'), 'the hints must come before the regex');
    }
  });

  test('every key a regex matches, one of its hints matches too', () => {
    let artifacts = 0;
    for (const { hints, re } of pairs) {
      for (const key of keys.filter((k) => new RegExp(re).test(k))) {
        artifacts += 1;
        assert.ok(hinted(hints, key), `${key} matches ${re} but none of ${JSON.stringify(hints)}`);
      }
    }
    assert.equal(artifacts, 44, 'every artifact in the fixture was checked');
  });

  test('an ordinary key matches no hint, so it never pays for a regex', () => {
    for (const key of ['files/Clients/Acme/hero.jpg', 'brand/2026/Deck final v3.pdf', 'a.txt']) {
      for (const { hints } of pairs) assert.ok(!hinted(hints, key), `${key} matches ${JSON.stringify(hints)}`);
    }
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

  test('every sort key orders on a known column with id as the tiebreaker', () => {
    for (const key of SORT_KEYS) {
      const { text } = buildFileQuery({ opts: { sort: key }, principal: admin });
      assert.match(text, /ORDER BY (f\.(created_at|name|updated_at)|coalesce\(f\.(size|mime), [^)]+\)) (ASC|DESC), f\.id (ASC|DESC)/, key);
    }
    // Object prototype names are not sorts.
    assert.equal(sortSpec('constructor').column, 'created_at');
    assert.equal(sortSpec('__proto__').column, 'created_at');
  });

  test('nullable columns order and page on the same NULL-free expression', () => {
    // A keyset comparison with a NULL is NULL, which ended paging early on
    // any page whose last row had no size.
    const size = buildFileQuery({ opts: { sort: 'size', cursor: { value: null, id: 'x' } }, principal: admin });
    assert.ok(size.text.includes('ORDER BY coalesce(f.size, -1) DESC, f.id DESC'));
    assert.ok(size.text.includes('(coalesce(f.size, -1), f.id) < ($'));
    assert.ok(size.params.includes(-1), 'a NULL cursor value becomes the stand-in');

    const type = buildFileQuery({ opts: { sort: 'type', cursor: { value: 'image/png', id: 'x' } }, principal: admin });
    assert.ok(type.text.includes("ORDER BY coalesce(f.mime, '') ASC, f.id ASC"));
    assert.ok(type.text.includes("(coalesce(f.mime, ''), f.id) > ($"));

    const small = buildFileQuery({ opts: { sort: 'small' }, principal: admin });
    assert.ok(small.text.includes('ORDER BY coalesce(f.size, -1) ASC'));
  });

  test('non-null columns are ordered bare, so their indexes still apply', () => {
    assert.ok(buildFileQuery({ opts: { sort: 'name_desc' }, principal: admin }).text.includes('ORDER BY f.name DESC, f.id DESC'));
    assert.ok(buildFileQuery({ opts: { sort: 'modified' }, principal: admin }).text.includes('ORDER BY f.updated_at DESC, f.id DESC'));
    assert.ok(buildFileQuery({ opts: { sort: 'modified_old' }, principal: admin }).text.includes('ORDER BY f.updated_at ASC, f.id ASC'));
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

describe('the folder tree query', () => {
  // The sidebar tree used to be derived from one default page of the listing,
  // so past 100 visible files the folders of older ones dropped out of it.
  const drives = [{ id: 'brand', prefix: 'brand' }, { id: 'acme', prefix: 'clients/acme' }];
  const member = {
    ...viewer,
    folderGrants: ['Clients'],
    drivePatterns: { all: drivePatterns(drives), mine: drivePatterns(drives.slice(0, 1)) },
  };
  const opts = { storagePrefix: 'files' };

  /** The top-level WHERE and its conditions, without what follows them. */
  const whereOf = (text) => text.slice(text.indexOf('\nWHERE ')).replace(/\nGROUP BY[\s\S]*$/, '');

  test('one row per folder, with its count, and no page to cut it short', () => {
    const { text } = buildFolderCountQuery({ opts, principal: member });
    assert.match(text, /^SELECT f\.folder, count\(\*\)::int AS n\nFROM files f\n/);
    assert.match(text, /\nGROUP BY f\.folder$/);
    assert.ok(!/LIMIT/.test(text), 'the tree must not be limited to a page');
    assert.ok(!/ORDER BY/.test(text));
  });

  test('the listing’s paging changes nothing', () => {
    const paged = buildFolderCountQuery({
      opts: { ...opts, limit: 5, sort: 'name', cursor: { value: 'a', id: 'x' } },
      principal: member,
    });
    assert.deepEqual(paged, buildFolderCountQuery({ opts, principal: member }));
    assert.ok(!/f\.id\) [<>]/.test(paged.text), 'a cursor must not narrow the tree');
  });

  test('it filters exactly as the listing does, drive boundary included', () => {
    // A difference either way is a folder the listing will not open, or one
    // it would open that the tree hides.
    const tree = buildFolderCountQuery({ opts, principal: member });
    const listing = buildFileQuery({ opts, principal: member });
    assert.equal(whereOf(tree.text), whereOf(listing.countText));
    assert.deepEqual(tree.params, listing.countParams);
    // …and what they share is the restrictive predicate, not an empty one.
    assert.ok(tree.text.includes('file_acl') && tree.text.includes("f.visibility = 'org'"), 'access predicate missing');
    assert.match(tree.text, /NOT \(coalesce\(f\.storage_key, ''\) LIKE ANY\(\$\d+::text\[\]\)\)/, 'drive boundary missing');
    assert.ok(tree.params.some((p) => Array.isArray(p) && p.includes('clients/acme/%')), 'drive patterns unbound');
    assert.ok(tree.params.some((p) => Array.isArray(p) && p.includes('Clients')), 'folder grants unbound');
  });

  test('every placeholder has a parameter, and every parameter is used', () => {
    const { text, params } = buildFolderCountQuery({ opts, principal: member });
    const used = new Set(placeholders(text));
    assert.equal(Math.max(...used), params.length);
    for (let i = 1; i <= params.length; i++) {
      assert.ok(used.has(i), `param $${i} is bound but never referenced`);
    }
  });

  test('scoped to the filespace, and to live files that are not artifacts', () => {
    const { text, params } = buildFolderCountQuery({ opts: { storagePrefix: '/clients/acme/' }, principal: viewer });
    assert.ok(params.includes('clients/acme') && params.includes('clients/acme/%'));
    assert.ok(text.includes('f.deleted_at IS NULL'));
    assert.ok(text.includes('NOT EXISTS (SELECT 1 FROM files t'), 'legacy thumbnails would count as files');
  });

  test('an absent principal is untrusted, not an admin', () => {
    assert.ok(buildFolderCountQuery({}).text.includes('file_acl'));
    assert.ok(!buildFolderCountQuery({ principal: admin }).text.includes('file_acl'));
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

  test('nextCursor replaces a NULL sort value with the sort\'s stand-in', () => {
    const rows = [{ size: 5, id: 'a' }, { size: null, id: 'b' }];
    assert.deepEqual(nextCursor(rows, sortSpec('size'), 2), { value: -1, id: 'b' });
    assert.deepEqual(nextCursor([{ mime: null, id: 'c' }], sortSpec('type'), 1), { value: '', id: 'c' });
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
