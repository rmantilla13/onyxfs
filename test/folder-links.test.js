// Folder links: where the folder ends. The pure rules (lib/folder-links.js) —
// which subfolder a request may name, which scope a stored link reaches, and
// whether one loaded file is in it — and the SQL they build, which must say
// the same thing and never carry a value in its text. What the SQL does
// against a real database is test/folder-shares-api.test.js's.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  linkSubpath, linkRootProblem, storedRoot, folderWithin, relativeTo, linkCrumbs, isLinkFileId,
  folderLinkScope, fileInLink, linkTile, linkFolderHref, linkFileHref,
  buildLinkFilesQuery, buildLinkCountQuery, buildLinkFoldersQuery, buildLinkFileQuery, buildLinkAnyQuery,
  LINK_PAGE, LINK_PAGE_MAX, MAX_LINK_PATH,
} from '../lib/folder-links.js';

describe('the subfolder a request names', () => {
  test('the link itself, and folders inside it, in the canonical form its pages link to', () => {
    assert.equal(linkSubpath(undefined), '');
    assert.equal(linkSubpath(null), '');
    assert.equal(linkSubpath(''), '');
    assert.equal(linkSubpath('Day 1'), 'Day 1');
    assert.equal(linkSubpath('Day 1/Selects'), 'Day 1/Selects');
    assert.equal(linkSubpath('Café/Q1_2024 (final)'), 'Café/Q1_2024 (final)');
  });

  test('never a way out: no dot segments, absolute paths or empty segments', () => {
    for (const bad of ['..', '.', '../Q10', 'a/../../b', 'a/..', './a', '/abs', '/', 'a/', 'a//b', '//etc/passwd']) {
      assert.equal(linkSubpath(bad), null, bad);
    }
  });

  test('decoded once, by the URL parser, and never again: an encoded slash is a character, not a way up', () => {
    const qs = new URLSearchParams('path=a%2F..%2F..');
    assert.equal(linkSubpath(qs.get('path')), null, 'a%2F..%2F.. decodes to a/../.. — refused');
    const twice = new URLSearchParams('path=a%252F..%252F..').get('path');
    assert.equal(twice, 'a%2F..%2F..');
    assert.equal(linkSubpath(twice), twice, 'a literal name, which matches no folder');
    assert.equal(folderWithin('Q1', twice), 'Q1/a%2F..%2F..', 'and stays inside the link');
    assert.equal(linkSubpath(new URLSearchParams('path=%2e%2e').get('path')), null);
  });

  test('not the app’s own folders, control characters, padded names, or anything too long', () => {
    for (const bad of ['_thumbs', 'a/_trash', '_THUMBS/x', 'a/\u0000b', 'a\nb', ' a', 'a /b', 'x'.repeat(256)]) {
      assert.equal(linkSubpath(bad), null, JSON.stringify(bad));
    }
    assert.equal(linkSubpath('a/'.repeat(MAX_LINK_PATH / 2) + 'a'), null);
    assert.equal(linkSubpath(42), null);
    assert.equal(linkSubpath(['a']), null);
  });

  test('a subpath only ever narrows inside the link’s folder', () => {
    assert.equal(folderWithin('Q1', ''), 'Q1');
    assert.equal(folderWithin('Q1', 'sub/deeper'), 'Q1/sub/deeper');
    assert.equal(relativeTo('Q1', 'Q1'), '');
    assert.equal(relativeTo('Q1', 'Q1/sub'), 'sub');
    assert.equal(relativeTo('Q1', 'Q10'), null, 'Q10 is not inside Q1');
    assert.equal(relativeTo('Q1', 'Q10/sub'), null);
    assert.equal(relativeTo('Q1', 'Q1_2024'), null);
    assert.equal(relativeTo('Q1', 'Q'), null);
    assert.equal(relativeTo('A/Q1', 'A'), null, 'never above it');
    assert.equal(relativeTo('Q1', ''), null);
  });

  test('the trail starts at the shared folder, never above it', () => {
    assert.deepEqual(linkCrumbs('Clients/Acme/Q1', ''), [{ sub: '', name: 'Q1' }]);
    assert.deepEqual(linkCrumbs('Clients/Acme/Q1', 'Day 1/Selects'), [
      { sub: '', name: 'Q1' },
      { sub: 'Day 1', name: 'Day 1' },
      { sub: 'Day 1/Selects', name: 'Selects' },
    ]);
  });

  test('hrefs are built from encoded parts', () => {
    assert.equal(linkFolderHref('tok'), '/s/tok');
    assert.equal(linkFolderHref('tok', 'Day 1/a&b'), '/s/tok?path=Day+1%2Fa%26b');
    assert.equal(new URLSearchParams(linkFolderHref('tok', 'Day 1/a&b').split('?')[1]).get('path'), 'Day 1/a&b');
    assert.equal(linkFileHref('tok', 'f/../x'), '/s/tok/files/f%2F..%2Fx');
  });

  test('a file id is looked up only when it could be one', () => {
    assert.ok(isLinkFileId('3f1c2c9e-6c1e-4a53-8d1f-0a9b7f3c2e11'));
    for (const bad of ['', '../x', 'a/b', 'x'.repeat(65), null, 7, 'a b']) assert.ok(!isLinkFileId(bad), String(bad));
  });
});

describe('the folder a link is made to', () => {
  test('a folder, never a whole drive or the library, never the app’s own', () => {
    assert.equal(linkRootProblem('Q1'), null);
    assert.equal(linkRootProblem('Clients/Acme'), null);
    assert.match(linkRootProblem(''), /whole drive/);
    assert.match(linkRootProblem('/'), /whole drive/);
    assert.match(linkRootProblem(undefined), /Choose a folder/);
    assert.match(linkRootProblem('_thumbs'), /reserved/);
    assert.match(linkRootProblem('a/../b'), /reserved/);
  });

  test('a stored root is served only as the Files view stores a folder path', () => {
    assert.equal(storedRoot('Q1'), 'Q1');
    assert.equal(storedRoot('A/B'), 'A/B');
    for (const bad of ['', '/Q1', 'Q1/', 'a//b', ' Q1', '..', 'a/..', '_trash', 'x/_thumbs', null, 3]) {
      assert.equal(storedRoot(bad), null, String(bad));
    }
  });
});

const DRIVES = [
  { id: 'team', prefix: 'team', shareKinds: null },
  { id: 'acme', prefix: 'team/Clients/acme', shareKinds: ['private'] },
  { id: 'open', prefix: 'team/Clients/open', shareKinds: ['public', 'password', 'private'] },
  { id: 'locked', prefix: 'locked', shareKinds: [] },
];
const row = (over = {}) => ({ kind: 'folder', mode: 'public', folder: 'Clients', storage_prefix: 'team', password_hash: null, ...over });

describe('what a stored link reaches', () => {
  test('a drive’s link: its drive, less the drives inside it that do not allow the link’s kind', () => {
    const s = folderLinkScope({ row: row(), drives: DRIVES });
    assert.deepEqual(s, { root: 'Clients', prefix: 'team', library: false, tag: 'team', kind: 'public', exclude: ['team/Clients/acme', 'locked'] });
    const pw = folderLinkScope({ row: row({ password_hash: 'scrypt$x' }), drives: DRIVES });
    assert.equal(pw.kind, 'password');
    assert.deepEqual(pw.exclude, ['team/Clients/acme', 'locked']);
  });

  test('the library’s link: the storage prefix, and no drive at all', () => {
    const s = folderLinkScope({ row: row({ storage_prefix: null, folder: 'Q1' }), drives: DRIVES, libraryPrefix: '/media/' });
    assert.deepEqual(s, { root: 'Q1', prefix: 'media', library: true, tag: '', kind: 'public', exclude: DRIVES.map((d) => d.prefix) });
    assert.equal(folderLinkScope({ row: row({ storage_prefix: null }), drives: [] }).prefix, 'files', 'the default prefix');
  });

  test('gone when its drive is; blocked when its drive stopped allowing it; missing when it could never be served', () => {
    assert.deepEqual(folderLinkScope({ row: row({ storage_prefix: 'deleted' }), drives: DRIVES }), { state: 'gone' });
    assert.deepEqual(folderLinkScope({ row: row({ storage_prefix: 'locked', folder: 'A' }), drives: DRIVES }), { state: 'blocked' });
    assert.deepEqual(folderLinkScope({ row: row({ folder: 'Clients/acme/x' }), drives: DRIVES }), { state: 'blocked' }, 'inside a drive that allows no public link');
    assert.deepEqual(folderLinkScope({ row: row({ mode: 'private' }), drives: DRIVES }), { state: 'missing' });
    assert.deepEqual(folderLinkScope({ row: row({ folder: '' }), drives: DRIVES }), { state: 'missing' });
    assert.deepEqual(folderLinkScope({ row: row({ folder: '../x' }), drives: DRIVES }), { state: 'missing' });
    assert.deepEqual(folderLinkScope({ row: row({ folder: '_thumbs' }), drives: DRIVES }), { state: 'missing' });
    assert.deepEqual(folderLinkScope({ row: row({ kind: 'file' }), drives: DRIVES }), { state: 'missing' });
    assert.deepEqual(folderLinkScope({ row: null }), { state: 'missing' });
  });
});

const SCOPE = folderLinkScope({ row: row({ folder: 'Q1' }), drives: DRIVES });
const file = (over = {}) => ({
  id: 'f1', name: 'a.jpg', folder: 'Q1', storage: 's3', storageKey: 'team/Q1/a.jpg', visibility: 'org', deletedAt: null, ...over,
});

describe('whether one file is in the link', () => {
  test('in the folder or beneath it, where its folder says', () => {
    assert.ok(fileInLink(file(), SCOPE));
    assert.ok(fileInLink(file({ folder: 'Q1/Day 1', storageKey: 'team/Q1/Day 1/b.mp4' }), SCOPE));
  });

  test('the boundary is whole segments: Q1 is not Q10, nor Q1_2024 Q1-2024', () => {
    assert.ok(!fileInLink(file({ folder: 'Q10', storageKey: 'team/Q10/a.jpg' }), SCOPE));
    assert.ok(!fileInLink(file({ folder: 'Q1x', storageKey: 'team/Q1x/a.jpg' }), SCOPE));
    const odd = folderLinkScope({ row: row({ folder: 'Q1_2024' }), drives: DRIVES });
    assert.ok(fileInLink(file({ folder: 'Q1_2024', storageKey: 'team/Q1_2024/a.jpg' }), odd));
    assert.ok(!fileInLink(file({ folder: 'Q1-2024', storageKey: 'team/Q1-2024/a.jpg' }), odd));
  });

  test('the folder and the key have to agree', () => {
    assert.ok(!fileInLink(file({ folder: 'Q2', storageKey: 'team/Q1/a.jpg' }), SCOPE), 'moved out in the catalog, object left behind');
    assert.ok(!fileInLink(file({ folder: 'Q1', storageKey: 'team/elsewhere/a.jpg' }), SCOPE), 'a key that spells somewhere else');
    assert.ok(!fileInLink(file({ folder: 'Q1', storageKey: 'team/Q1/deeper/a.jpg' }), SCOPE), 'a key deeper than its folder');
    assert.ok(!fileInLink(file({ folder: 'Q1', storageKey: 'other/Q1/a.jpg' }), SCOPE), 'another scope’s Q1');
    assert.ok(!fileInLink(file({ folder: 'Q1', storageKey: 'team/Q1/' }), SCOPE), 'no name at all');
  });

  test('live, in the bucket, and the workspace’s to see', () => {
    assert.ok(!fileInLink(file({ deletedAt: 1 }), SCOPE));
    assert.ok(!fileInLink(file({ storage: 'blob' }), SCOPE));
    assert.ok(!fileInLink(file({ storageKey: null }), SCOPE));
    assert.ok(!fileInLink(file({ visibility: 'owner' }), SCOPE));
    assert.ok(!fileInLink(file({ visibility: 'custom' }), SCOPE));
    assert.ok(!fileInLink(file({ visibility: undefined }), SCOPE));
  });

  test('nothing of the app’s own, no previews or OS junk', () => {
    assert.ok(!fileInLink(file({ folder: 'Q1/_thumbs', storageKey: 'team/Q1/_thumbs/x.webp' }), SCOPE));
    assert.ok(!fileInLink(file({ folder: 'Q1/_Trash', storageKey: 'team/Q1/_Trash/x.jpg' }), SCOPE));
    assert.ok(!fileInLink(file({ storageKey: 'team/Q1/abc-thumb-a.jpg' }), SCOPE));
    assert.ok(!fileInLink(file({ storageKey: 'team/Q1/.DS_Store' }), SCOPE));
    assert.ok(!fileInLink(file({ storageKey: 'team/Q1/._a.jpg' }), SCOPE));
  });

  test('not across a drive boundary', () => {
    const clients = folderLinkScope({ row: row({ folder: 'Clients' }), drives: DRIVES });
    assert.ok(fileInLink(file({ folder: 'Clients/open', storageKey: 'team/Clients/open/x.jpg' }), clients), 'a drive inside that allows it');
    assert.ok(!fileInLink(file({ folder: 'Clients/acme', storageKey: 'team/Clients/acme/x.jpg' }), clients), 'one that does not');
    const lib = folderLinkScope({ row: row({ storage_prefix: null, folder: 'Q1' }), drives: [...DRIVES, { prefix: 'files/Q1/drive' }] });
    assert.ok(fileInLink(file({ storageKey: 'files/Q1/a.jpg' }), lib));
    assert.ok(!fileInLink(file({ folder: 'Q1/drive', storageKey: 'files/Q1/drive/a.jpg' }), lib), 'the library reaches no drive');
    assert.ok(!fileInLink(file(), lib), 'a drive’s Q1 is not the library’s');
  });
});

describe('the queries', () => {
  const values = (q) => q.params.flat();

  test('every value is a parameter: nothing from a request is in the text', () => {
    const at = 'Q1/it’s; DROP TABLE files; --';
    const sub = folderLinkScope({ row: row({ folder: 'Q1' }), drives: DRIVES });
    for (const q of [
      buildLinkFilesQuery({ scope: sub, at, cursor: { value: "x' OR 1=1 --", id: "'; --" } }),
      buildLinkCountQuery({ scope: sub, at }),
      buildLinkFoldersQuery({ scope: sub, at }),
      buildLinkFileQuery({ scope: sub, id: "1' OR '1'='1" }),
      buildLinkAnyQuery({ scope: sub }),
    ]) {
      assert.ok(!q.text.includes('DROP TABLE'), q.text);
      assert.ok(!q.text.includes("OR '1'='1"), q.text);
      assert.ok(!q.text.includes('team'), 'the prefix is a parameter too');
      assert.match(q.text, /f\.deleted_at IS NULL/);
      assert.match(q.text, /f\.visibility = 'org'/);
      assert.match(q.text, /f\.storage = 's3'/);
    }
  });

  test('the folder is held to whole segments, by key and by folder', () => {
    const q = buildLinkFilesQuery({ scope: SCOPE, at: 'Q1' });
    // Keys from 'team/Q1/' up to, not including, 'team/Q10', byte-wise: every
    // key that begins 'team/Q1/', and not one that begins 'team/Q10'.
    assert.ok(values(q).includes('team/Q1/') && values(q).includes('team/Q10'));
    assert.match(q.text, /f\.storage_key ~>=~ \$\d+::text/);
    assert.match(q.text, /f\.storage_key ~<~ \$\d+::text/);
    assert.ok('team/Q1/a.jpg' >= 'team/Q1/' && 'team/Q1/a.jpg' < 'team/Q10');
    assert.ok(!('team/Q10/a.jpg' < 'team/Q10'), 'Q10 is past the end of Q1');
    assert.ok(values(q).includes('Q1'));
    assert.match(q.text, /f\.folder = \$\d+/);
    const deeper = buildLinkFilesQuery({ scope: SCOPE, at: 'Q1/sub' });
    assert.ok(values(deeper).includes('team/Q1/sub/') && values(deeper).includes('team/Q1/sub0'), 'and a subfolder its own range');
    assert.ok(!/f\.folder (NOT )?I?LIKE/.test(q.text), 'no LIKE on a folder name: its _ and % are characters');
    const sub = buildLinkFoldersQuery({ scope: SCOPE, at: 'Q1' });
    assert.ok(values(sub).includes('Q1/'), 'subfolders are under "Q1/", never "Q1%"');
    const one = buildLinkFileQuery({ scope: SCOPE, id: 'x' });
    assert.ok(values(one).includes('Q1') && values(one).includes('Q1/'));
  });

  test('drives outside the link are kept out by LIKE patterns with their wildcards escaped', () => {
    const lib = folderLinkScope({ row: row({ storage_prefix: null, folder: 'Q1' }), drives: [{ prefix: 'a_b%c' }] });
    const q = buildLinkFilesQuery({ scope: lib, at: 'Q1' });
    assert.ok(values(q).includes('a\\_b\\%c/%'));
    assert.match(q.text, /NOT \(f\.storage_key LIKE ANY\(\$\d+::text\[\]\)\)/);
  });

  test('nothing is asked of a folder outside the link', () => {
    assert.throws(() => buildLinkFilesQuery({ scope: SCOPE, at: 'Q10' }), /outside/);
    assert.throws(() => buildLinkCountQuery({ scope: SCOPE, at: 'Q' }), /outside/);
    assert.throws(() => buildLinkFoldersQuery({ scope: SCOPE, at: '' }), /outside/);
    assert.throws(() => buildLinkFilesQuery({ scope: null, at: 'Q1' }), /scope/);
  });

  test('pages are keyset pages, by name then id, of a bounded size', () => {
    const first = buildLinkFilesQuery({ scope: SCOPE, at: 'Q1' });
    assert.equal(first.limit, LINK_PAGE);
    assert.match(first.text, /ORDER BY f\.name ASC, f\.id ASC/);
    assert.ok(!first.text.includes('(f.name, f.id) >'));
    const next = buildLinkFilesQuery({ scope: SCOPE, at: 'Q1', cursor: { value: 'm.jpg', id: 'f9' }, limit: 5000 });
    assert.equal(next.limit, LINK_PAGE_MAX);
    assert.match(next.text, /\(f\.name, f\.id\) > \(\$\d+::text, \$\d+::text\)/);
    assert.ok(values(next).includes('m.jpg') && values(next).includes('f9'));
    // A cursor that is not one the listing made is the first page, not an error.
    assert.ok(!buildLinkFilesQuery({ scope: SCOPE, at: 'Q1', cursor: { value: 7, id: 'x' } }).text.includes('(f.name, f.id) >'));
    assert.equal(buildLinkFilesQuery({ scope: SCOPE, at: 'Q1', limit: -1 }).limit, LINK_PAGE);
  });
});

test('a card is handed what it draws, and a signed original only where it draws one', () => {
  const signed = {
    id: 'f', name: 'a.jpg', mime: 'image/jpeg', kind: 'image', size: 1000, folder: 'Q1', storageKey: 'team/Q1/a.jpg',
    createdBy: 'someone@x.test', tags: ['secret'], url: 'https://signed/original', thumbnailUrl: 'https://signed/thumb',
    posterUrl: 'https://signed/poster', filmstripUrl: 'https://signed/strip', proxyUrl: 'https://signed/proxy',
    thumbSizes: ['sm'], smUrl: 'https://signed/sm', metadata: { width: 10, height: 10, project: 'Hush' },
  };
  const t = linkTile(signed);
  assert.deepEqual(Object.keys(t).sort(), ['id', 'kind', 'metadata', 'mime', 'name', 'size', 'smUrl', 'thumbSizes', 'thumbnailUrl'].sort());
  assert.deepEqual(t.metadata, { width: 10, height: 10 }, 'the media facts, not the library’s fields');
  // No preview of its own: a small picture stands in with its original; a big one or a video does not.
  assert.equal(linkTile({ ...signed, thumbnailUrl: null }).url, 'https://signed/original');
  assert.equal(linkTile({ ...signed, thumbnailUrl: null, size: 50 * 1024 * 1024 }).url, undefined);
  assert.equal(linkTile({ ...signed, thumbnailUrl: null, kind: 'video', mime: 'video/mp4', name: 'a.mp4' }).url, undefined);
});
