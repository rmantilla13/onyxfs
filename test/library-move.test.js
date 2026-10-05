// lib/library-move.js — the pure rules of moving the files outside every
// drive into one: where the bytes can go, where each file lands and what it
// is called there, what to do with what a stopped call left, and the names
// the library's collections take in the drive. The route that does the I/O
// around these is test/library-move-api.test.js's.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  moveRoute, landingFolder, landedName, isLooseKey, noteState, freeName, collectionMoves, heldFolders, folderLandings, isNameOf,
} from '../lib/library-move.js';

const BASE = { provider: 's3', bucket: 'onyx', endpoint: 'https://s3.example', prefix: 'files' };

describe('where the bytes can go (moveRoute)', () => {
  test('the Storage bucket, or a bucket of its own the same keys reach', () => {
    assert.deepEqual(moveRoute(BASE, { name: 'Team', prefix: 'team' }), { mode: 'within' });
    assert.deepEqual(moveRoute(BASE, { name: 'Team', prefix: 'team', bucket: 'onyx' }), { mode: 'within' });
    assert.deepEqual(moveRoute(BASE, { name: 'Vault', prefix: 'v', bucket: 'vault' }), { mode: 'across' });
  });

  test('keys of its own in the Storage bucket on the same service: the Storage keys still reach it', () => {
    const own = { name: 'Team', prefix: 'team', bucket: 'onyx', accessKeyId: 'k', hasSecret: true };
    assert.deepEqual(moveRoute(BASE, { ...own, endpoint: 'S3.example/' }), { mode: 'within' });
    assert.deepEqual(moveRoute({ ...BASE, endpoint: '' }, { ...own, endpoint: '' }), { mode: 'within' });
  });

  test('a bucket of its own in another region says so, and is still copied into', () => {
    const base = { ...BASE, region: 'us-east-1' };
    const far = moveRoute(base, { name: 'Europe', prefix: 'eu', bucket: 'eu-files', region: 'eu-west-1' });
    assert.equal(far.mode, 'across');
    assert.match(far.warning, /^“Europe” keeps its files in a bucket in eu-west-1, and these are in us-east-1: every byte copied crosses/);
    assert.deepEqual(moveRoute(base, { name: 'Near', prefix: 'n', bucket: 'near', region: 'US-East-1' }), { mode: 'across' });
    assert.deepEqual(moveRoute({ ...BASE, region: 'auto' }, { name: 'R2', prefix: 'r', bucket: 'r2', region: 'eu-west-1' }), { mode: 'across' }, 'no region to compare');
    assert.deepEqual(moveRoute(base, { name: 'Same', prefix: 's', region: 'eu-west-1' }), { mode: 'within' }, 'the Storage bucket itself');
  });

  test('keys of its own anywhere else, or no folder in the bucket: refused, saying why', () => {
    const other = moveRoute(BASE, { name: 'Client', prefix: 'c', bucket: 'client', accessKeyId: 'k', secretAccessKey: 's' });
    assert.match(other.problem, /^“Client” keeps its files in a bucket of its own, with keys of its own/);
    const elsewhere = moveRoute(BASE, { name: 'R2', prefix: 'c', bucket: 'onyx', accessKeyId: 'k', hasSecret: true, endpoint: 'https://r2.example' });
    assert.ok(elsewhere.problem, 'the same bucket name on another service is another bucket');
    assert.equal(moveRoute(BASE, { name: 'Odd', prefix: '/' }).problem, '“Odd” has no folder in the bucket to move files into.');
  });
});

describe('where a file lands, and what it is called', () => {
  test('its own folder under the one chosen', () => {
    assert.equal(landingFolder('', 'Shoot/Day 1'), 'Shoot/Day 1');
    assert.equal(landingFolder('From the library/', '/Shoot'), 'From the library/Shoot');
    assert.equal(landingFolder('Old', ''), 'Old');
    assert.equal(landingFolder('', ''), '');
  });

  test('its name, with the suffix the key was given where the one asked for was taken', () => {
    assert.equal(landedName('a.jpg', 'a.jpg', 'a.jpg'), 'a.jpg');
    assert.equal(landedName('a.jpg', 'a.jpg', 'a (2).jpg'), 'a (2).jpg');
    assert.equal(landedName('Café.jpg', 'Caf_.jpg', 'Caf_.jpg'), 'Café.jpg', 'the key is spelled for the bucket; the name is the file’s');
    assert.equal(landedName('Café.jpg', 'Caf_.jpg', 'Caf_ (3).jpg'), 'Café (3).jpg');
    assert.equal(landedName('README', 'README', 'README (2)'), 'README (2)');
    assert.equal(landedName('x.tar.gz', 'x.tar.gz', 'x.tar (2).gz'), 'x.tar (2).gz');
  });

  test('outside every drive: under none of their prefixes, as whole segments', () => {
    const drives = ['team', 'clients/acme/'];
    assert.equal(isLooseKey('files/a.jpg', drives), true);
    assert.equal(isLooseKey('teamwork/a.jpg', drives), true);
    assert.equal(isLooseKey('team/a.jpg', drives), false);
    assert.equal(isLooseKey('clients/acme/a.jpg', drives), false);
    assert.equal(isLooseKey('', drives), false);
  });
});

describe('a noted copy is carried on from only under the file’s own name (isNameOf)', () => {
  test('the name, or one s3UniqueKey makes of it in the same folder', () => {
    assert.ok(isNameOf('team/Shoot/a.jpg', 'team/Shoot/a.jpg'));
    assert.ok(isNameOf('team/Shoot/a (2).jpg', 'team/Shoot/a.jpg'));
    assert.ok(isNameOf('team/Shoot/a (12)', 'team/Shoot/a'));
    assert.ok(isNameOf('team/a (b) (3).tar', 'team/a (b).tar'));
  });

  test('never another name, folder or suffix', () => {
    assert.ok(!isNameOf('team/Shoot/old.jpg', 'team/Shoot/a.jpg'), 'a file renamed since');
    assert.ok(!isNameOf('team/Other/a.jpg', 'team/Shoot/a.jpg'));
    assert.ok(!isNameOf('team/Shoot/x/a (2).jpg', 'team/Shoot/a.jpg'));
    assert.ok(!isNameOf('team/Shoot/a (2).png', 'team/Shoot/a.jpg'));
    assert.ok(!isNameOf('team/Shoot/a (two).jpg', 'team/Shoot/a.jpg'));
    assert.ok(!isNameOf('team/Shoot/ab (2).jpg', 'team/Shoot/a.jpg'));
    assert.ok(!isNameOf('', 'team/a.jpg'));
  });
});

describe('folders that still hold a file outside every drive', () => {
  test('each, and every folder above it, composed', () => {
    assert.deepEqual([...heldFolders(['Shoot/Day 1', '/Cafe\u0301/', ''])].sort(), ['Caf\u00e9', 'Shoot', 'Shoot/Day 1']);
  });

  test('are copied: the drive takes their tags, and the library keeps them; the rest move', () => {
    const rows = [
      { name: 'Shoot', tags: ['spring'] },
      { name: 'Shoot/Day 1' },
      { name: 'Done', tags: ['done'] },
      { name: 'Cafe\u0301', tags: ['paris'] },
      { name: 'Caf\u00e9', tags: ['lyon'] },
    ];
    const destOf = (p) => landingFolder('2025', p.normalize('NFC'));
    const groups = folderLandings(rows, destOf, { held: heldFolders(['Shoot/Day 1', 'Caf\u00e9']) });
    assert.deepEqual(groups.map((g) => [g.dest, g.copy]).sort(), [
      ['2025/Caf\u00e9', true], ['2025/Done', false], ['2025/Shoot', true], ['2025/Shoot/Day 1', true],
    ]);
    assert.deepEqual(groups.find((g) => g.dest === '2025/Caf\u00e9').tags, ['paris', 'lyon'], 'twins, one held, are copied as one');
    assert.ok(folderLandings(rows, destOf).every((g) => !g.copy), 'with nothing held, everything moves');
  });
});

describe('what a stopped call left (noteState)', () => {
  const note = { toKey: 'team/a.jpg', fromKey: 'files/a.jpg' };
  const held = (...keys) => new Set(keys);
  test('each of the four', () => {
    assert.equal(noteState(note, held('team/a.jpg')), 'tidy', 'moved; the original was not deleted');
    assert.equal(noteState(note, held('team/a.jpg', 'files/a.jpg')), 'forget', 'another file still holds the original');
    assert.equal(noteState(note, held('files/a.jpg')), 'reuse', 'copied; the file has not moved yet');
    assert.equal(noteState(note, held()), 'orphan', 'the file has gone since');
  });
});

describe('collections, into the drive', () => {
  test('a name the drive has is given the next free one, as a person would read it', () => {
    assert.equal(freeName('Selects', []), 'Selects');
    assert.equal(freeName('Selects', ['selects ']), 'Selects (2)');
    assert.equal(freeName('Selects', ['Selects', 'Selects (2)']), 'Selects (3)');
    assert.equal(freeName('x'.repeat(80), ['x'.repeat(80)]).length, 80);
  });

  test('only the library’s move, each named apart from the drive’s and from each other', () => {
    const all = [
      { id: 'a', driveId: '', name: 'Selects' },
      { id: 'b', driveId: 'd1', name: 'Selects' },
      { id: 'c', driveId: '', name: 'Selects (2)' },
      { id: 'd', driveId: 'd2', name: 'Selects' },
      { id: 'e', name: 'Hero shots' },
    ];
    assert.deepEqual(collectionMoves(all, { driveId: 'd1' }), [
      { id: 'a', name: 'Selects (2)' },
      { id: 'c', name: 'Selects (2) (2)' },
      { id: 'e', name: 'Hero shots' },
    ]);
    assert.deepEqual(collectionMoves(all.filter((c) => c.driveId === 'd2'), { driveId: 'd1' }), []);
  });
});
