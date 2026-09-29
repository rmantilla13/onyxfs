// What the files page marks as kept offline by Onyx for Mac
// (lib/offline-marks.js). A wrong mark is worse than none: someone trusts it,
// disconnects, and the file is not there. So each rule is pinned from both
// sides — what is marked, and what is not.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { offlineMarks, keptFolderAbove, keptWith, samePinnedFolders, sameSet, scopeOf } from '../lib/offline-marks.js';

const drives = [
  { id: 'brand', prefix: 'brand-assets' },
  { id: 'clients', prefix: 'clients' },
  { id: 'acme', prefix: 'clients/acme' }, // a drive inside another
];
const file = (id, folder, storageKey) => ({ id, folder, storageKey });

describe('scopes', () => {
  test('are the app\'s names for them', () => {
    assert.equal(scopeOf('brand'), 'drive.brand');
    assert.equal(scopeOf(''), 'library');
    assert.equal(scopeOf(null), 'library');
  });
});

describe('the kept folder above a path', () => {
  const rules = [
    { scope: 'drive.brand', path: 'Footage' },
    { scope: 'drive.brand', path: 'Footage/Day 1' },
    { scope: 'library', path: '' },
  ];

  test('is the nearest one, the folder itself included', () => {
    assert.equal(keptFolderAbove(rules, 'drive.brand', 'Footage/Day 1/Cam A'), 'Footage/Day 1');
    assert.equal(keptFolderAbove(rules, 'drive.brand', 'Footage/Day 1'), 'Footage/Day 1');
    assert.equal(keptFolderAbove(rules, 'drive.brand', 'Footage/Day 2'), 'Footage');
  });

  test('stops at a folder boundary, not a prefix of the name', () => {
    assert.equal(keptFolderAbove(rules, 'drive.brand', 'Footage 2'), null);
    assert.equal(keptFolderAbove(rules, 'drive.brand', 'Footage/Day 10'), 'Footage');
  });

  test('is only ever of the same drive', () => {
    assert.equal(keptFolderAbove(rules, 'drive.clients', 'Footage'), null);
  });

  test('is the whole drive when that is what is kept', () => {
    assert.equal(keptFolderAbove(rules, 'library', 'Anything/at/all'), '');
    assert.equal(keptFolderAbove(rules, 'library', ''), '');
  });

  test('is nothing for rules that are not folders', () => {
    assert.equal(keptFolderAbove([null, { scope: 'library' }, { scope: 'library', path: 7 }], 'library', 'a'), null);
    assert.equal(keptFolderAbove(undefined, 'library', 'a'), null);
  });
});

describe('files', () => {
  test('are kept when the app lists them, whatever the folders say', () => {
    const marks = offlineMarks({ pinned: new Set(['f1']), driveId: 'brand', drives });
    assert.equal(marks.file(file('f1', 'Anywhere', 'brand-assets/Anywhere/x.mov')), true);
    assert.equal(marks.file(file('f2', 'Anywhere', 'brand-assets/Anywhere/y.mov')), false);
    assert.equal(marks.fileKeptBy(file('f1', 'Anywhere')), null, 'kept on its own, not by a folder');
  });

  test('in a kept folder are kept before the app has listed them', () => {
    const marks = offlineMarks({ pinned: [], pinnedFolders: [{ scope: 'drive.brand', path: 'Footage' }], driveId: 'brand', drives });
    assert.equal(marks.file(file('f1', 'Footage/Day 1', 'brand-assets/Footage/Day 1/a.mp4')), true);
    assert.deepEqual(marks.fileKeptBy(file('f1', 'Footage/Day 1')), { scope: 'drive.brand', path: 'Footage' });
    assert.equal(marks.file(file('f2', 'Stills', 'brand-assets/Stills/b.jpg')), false);
  });

  test('on All files, a kept folder marks only its own drive\'s files', () => {
    const marks = offlineMarks({
      pinned: new Set(),
      pinnedFolders: [{ scope: 'drive.brand', path: 'Footage' }, { scope: 'library', path: 'Docs' }],
      driveId: '',
      drives,
    });
    assert.equal(marks.file(file('a', 'Footage', 'brand-assets/Footage/a.mp4')), true);
    assert.equal(marks.file(file('b', 'Footage', 'clients/Footage/b.mp4')), false, 'another drive\'s Footage');
    assert.equal(marks.file(file('c', 'Footage', 'files/Footage/c.mp4')), false, 'the library\'s own Footage');
    assert.equal(marks.file(file('d', 'Docs', 'files/Docs/d.pdf')), true, 'in no drive: the library\'s rules');
    assert.equal(marks.file(file('e', 'Docs', 'brand-assets/Docs/e.pdf')), false, 'a drive\'s Docs is not the library\'s');
  });

  test('in a drive inside another are kept by either drive\'s folders', () => {
    const marks = offlineMarks({ pinnedFolders: [{ scope: 'drive.clients', path: '' }], driveId: '', drives });
    assert.equal(marks.file(file('a', 'x', 'clients/acme/x/a.mp4')), true);
    assert.deepEqual(marks.fileKeptBy(file('a', 'x', 'clients/acme/x/a.mp4')), { scope: 'drive.clients', path: '' },
      'says which drive keeps it, for the words on its mark');
  });

  test('nothing kept marks nothing', () => {
    const marks = offlineMarks({});
    assert.equal(marks.any, false);
    assert.equal(marks.file(file('a', '', 'files/a')), false);
    assert.equal(marks.file(null), false);
    assert.deepEqual(marks.folder('x'), { kept: false, by: null });
    assert.equal(marks.drive('brand'), false);
  });
});

describe('folders and drives', () => {
  const marks = offlineMarks({
    pinnedFolders: [{ scope: 'drive.brand', path: 'Footage' }, { scope: 'drive.clients', path: '' }],
    driveId: 'brand',
    drives,
  });

  test('a kept folder, and the folders inside it', () => {
    assert.deepEqual(marks.folder('Footage'), { kept: true, by: 'Footage' });
    assert.deepEqual(marks.folder('Footage/Day 1'), { kept: true, by: 'Footage' });
    assert.deepEqual(marks.folder('Stills'), { kept: false, by: null });
  });

  test('a folder is judged in the page\'s drive only', () => {
    const elsewhere = offlineMarks({ pinnedFolders: [{ scope: 'drive.brand', path: 'Footage' }], driveId: 'clients', drives });
    assert.deepEqual(elsewhere.folder('Footage'), { kept: false, by: null });
  });

  test('a drive is kept when the whole of it is', () => {
    assert.equal(marks.drive('clients'), true);
    assert.equal(marks.drive('brand'), false, 'a folder in it is not the drive');
    assert.equal(offlineMarks({ pinnedFolders: [{ scope: 'library', path: '' }] }).drive(''), true);
  });
});

describe('the words', () => {
  test('name the folder that keeps it', () => {
    assert.equal(keptWith('Footage/Day 1', 'Brand'), 'Kept offline with “Day 1”');
    assert.equal(keptWith('', 'Brand'), 'Kept offline with “Brand”');
    assert.equal(keptWith('', ''), 'Kept offline with the whole drive');
    assert.equal(keptWith(null, 'Brand'), null);
  });
});

describe('an unchanged answer keeps its identity', () => {
  test('sets', () => {
    assert.equal(sameSet(new Set(['a', 'b']), new Set(['b', 'a'])), true);
    assert.equal(sameSet(new Set(['a']), new Set(['a', 'b'])), false);
    assert.equal(sameSet(new Set(['a']), new Set(['b'])), false);
  });

  test('kept folders', () => {
    const a = [{ scope: 'library', path: 'x' }];
    assert.equal(samePinnedFolders(a, [{ scope: 'library', path: 'x' }]), true);
    assert.equal(samePinnedFolders(a, [{ scope: 'library', path: 'y' }]), false);
    assert.equal(samePinnedFolders(a, []), false);
  });
});
