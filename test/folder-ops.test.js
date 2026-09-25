// The pure half of folder create / rename / move / delete: which names are
// allowed, and what a rename does to each stored object.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanFolder, folderNameProblem, folderPathProblem, isWithin, rebase, escapeLike,
  keyFor, planRename, mapLimit, settleLimit, parentOf, baseName, crumbsFor,
} from '../lib/folder-ops.js';

test('folder names: one segment, not reserved, not blank', () => {
  assert.equal(folderNameProblem('Q3 review'), null);
  assert.equal(folderNameProblem('Årsrapport (final)'), null);
  assert.match(folderNameProblem('  '), /Enter/);
  assert.match(folderNameProblem('a/b'), /cannot contain/);
  assert.match(folderNameProblem('..'), /reserved/);
  assert.match(folderNameProblem('_thumbs'), /reserved/);
  assert.match(folderNameProblem('_TRASH'), /reserved/);
  assert.match(folderNameProblem('x'.repeat(201)), /200/);
  assert.match(folderNameProblem('a\u0000b'), /control/);
  assert.equal(folderPathProblem('Clients/Acme/2026'), null);
  assert.match(folderPathProblem('Clients/_thumbs'), /reserved/);
});

test('paths are normalized and compared by segment, not by string prefix', () => {
  assert.equal(cleanFolder(' /Clients// Acme /'), 'Clients/Acme');
  assert.equal(parentOf('a/b/c'), 'a/b');
  assert.equal(parentOf('a'), '');
  assert.equal(baseName('a/b/c'), 'c');
  assert.ok(isWithin('Clients/Acme', 'Clients'));
  assert.ok(isWithin('Clients', 'Clients'));
  assert.ok(!isWithin('Clients2/Acme', 'Clients'), '"Clients2" is not inside "Clients"');
  assert.equal(rebase('Clients/Acme/raw', 'Clients', 'Archive/Clients'), 'Archive/Clients/Acme/raw');
  assert.equal(rebase('Clients', 'Clients', 'Customers'), 'Customers');
});

test('LIKE wildcards in a folder name are escaped', () => {
  assert.equal(escapeLike('a_b%c\\d'), 'a\\_b\\%c\\\\d');
});

test('keys follow <prefix>/<folder>/<name>, with no empty segments', () => {
  assert.equal(keyFor('files', 'Clients/Acme', 'a.jpg'), 'files/Clients/Acme/a.jpg');
  assert.equal(keyFor('files', '', 'a.jpg'), 'files/a.jpg');
  assert.equal(keyFor('', 'x', 'a.jpg'), 'x/a.jpg');
});

test('a rename re-keys the objects in this scope and leaves everything else alone', () => {
  const files = [
    { id: '1', folder: 'Clients', storage: 's3', storageKey: 'files/Clients/brief.pdf' },
    { id: '2', folder: 'Clients/Acme', storage: 's3', storageKey: 'files/Clients/Acme/logo (2).png' },
    // Same folder path, another filespace's prefix.
    { id: '3', folder: 'Clients', storage: 's3', storageKey: 'acme/Clients/x.mov' },
    // A row whose key no longer matches its folder (moved catalog-only once).
    { id: '4', folder: 'Clients', storage: 's3', storageKey: 'files/Elsewhere/y.mov' },
    // Blob storage: nothing in a bucket to move.
    { id: '5', folder: 'Clients/Acme', storage: 'blob', storageKey: null },
    // Not under the folder at all.
    { id: '6', folder: 'Clients2', storage: 's3', storageKey: 'files/Clients2/z.jpg' },
  ];
  const plan = planRename({ from: 'Clients', to: 'Archive/Customers', prefix: 'files', scoped: false, files });
  assert.deepEqual(plan.moves, [
    { id: '1', folder: 'Archive/Customers', fromKey: 'files/Clients/brief.pdf', toKey: 'files/Archive/Customers/brief.pdf' },
    { id: '2', folder: 'Archive/Customers/Acme', fromKey: 'files/Clients/Acme/logo (2).png', toKey: 'files/Archive/Customers/Acme/logo (2).png' },
  ]);
  assert.deepEqual(plan.catalog, [{ id: '5', folder: 'Archive/Customers/Acme' }]);
  assert.deepEqual(plan.outside.sort(), ['3', '4']);

  // Inside a filespace, a Blob row is not this scope's either.
  const scoped = planRename({ from: 'Clients', to: 'C', prefix: 'acme', scoped: true, files });
  assert.deepEqual(scoped.moves.map((m) => m.id), ['3']);
  assert.deepEqual(scoped.catalog, []);
  assert.ok(scoped.outside.includes('5'));
});

test('mapLimit keeps to its limit and reports the first failure after the rest settle', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.equal(peak, 3);

  const seen = [];
  await assert.rejects(mapLimit([1, 2, 3, 4], 2, async (n) => {
    seen.push(n);
    if (n === 2) throw new Error('copy failed');
  }), /copy failed/);
  assert.ok(!seen.includes(4) || seen.length <= 4);

  const settled = await settleLimit([1, 2], 2, async (n) => { if (n === 2) throw new Error('no'); return n; });
  assert.deepEqual(settled.map((r) => r.ok), [true, false]);
});

test('breadcrumbs: the root, every ancestor, then the folder itself', () => {
  assert.deepEqual(crumbsFor(''), [{ path: '', name: 'All files' }]);
  assert.deepEqual(crumbsFor('Campaigns/2026/Spring'), [
    { path: '', name: 'All files' },
    { path: 'Campaigns', name: 'Campaigns' },
    { path: 'Campaigns/2026', name: '2026' },
    { path: 'Campaigns/2026/Spring', name: 'Spring' },
  ]);
  // Paths arrive from the URL, so an untidy one still yields real folders.
  assert.deepEqual(crumbsFor('/a//b/').map((c) => c.path), ['', 'a', 'a/b']);
  assert.equal(crumbsFor('x', 'Library')[0].name, 'Library');
});
