import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { nfc, isAscii, respellPath, planFolderDelete } from '../lib/folder-ops.js';
import { cfgForKey, driveStorageDiffers } from '../lib/storage.js';

const NFD = 'Cafe\u0301';
const NFC = 'Caf\u00e9';

describe('names are composed on write', () => {
  test('nfc and isAscii', () => {
    assert.equal(nfc(NFD), NFC);
    assert.equal(nfc(null), '');
    assert.equal(isAscii('Photos (2)/a b'), true);
    assert.equal(isAscii(NFC), false);
  });

  test('respellPath reaches a folder stored in another spelling, segment by segment', () => {
    assert.equal(respellPath(`${NFC}/Sub`, [`${NFD}/Sub`]), `${NFD}/Sub`);
    assert.equal(respellPath(`Work/${NFC}`, [`Work/${NFD}/x`]), `Work/${NFD}`);
    assert.equal(respellPath(`${NFC}/New`, [NFD]), `${NFD}/New`, 'a new child of a decomposed folder');
  });

  test('an exact spelling wins, and nothing is borrowed from another parent', () => {
    assert.equal(respellPath(NFC, [NFD, NFC]), NFC);
    assert.equal(respellPath(`A/${NFC}`, [`B/${NFD}`]), `A/${NFC}`);
    assert.equal(respellPath(NFC, []), NFC);
    assert.equal(respellPath('', [NFD]), '');
  });
});

describe('planFolderDelete', () => {
  const files = [
    { id: 1, folder: 'Cuts', storage: 's3', storageKey: 'team/Cuts/a.mov' },
    { id: 2, folder: 'Cuts/Sub', storage: 's3', storageKey: 'team/Elsewhere/b.mov' },
    { id: 3, folder: 'Cuts', storage: 's3', storageKey: 'files/Cuts/c.mov' },
    { id: 4, folder: 'Cutsie', storage: 's3', storageKey: 'team/Cutsie/d.mov' },
    { id: 5, folder: 'Cuts', storage: 'local', storageKey: null },
  ];

  test('in a drive: every file in the folder by the drive’s prefix, whatever its key spells', () => {
    const { work, outside } = planFolderDelete({ name: 'Cuts', files, prefix: 'team', scoped: true });
    assert.deepEqual(work, [{ id: 1, key: 'team/Cuts/a.mov' }, { id: 2, key: 'team/Elsewhere/b.mov' }]);
    assert.deepEqual(outside, [3, 5]);
  });

  test('in the library: what no drive holds', () => {
    const { work, outside } = planFolderDelete({ name: 'Cuts', files, prefix: 'files', scoped: false, drivePrefixes: ['team'] });
    assert.deepEqual(work.map((w) => w.id), [3, 5]);
    assert.deepEqual(outside, [1, 2]);
  });
});

describe('a drive with its own bucket', () => {
  const base = { provider: 's3', bucket: 'main', accessKeyId: 'k', secretAccessKey: 's', region: 'us-east-1', prefix: 'files' };
  const same = { id: 'd1', prefix: 'team', bucket: 'main' };
  const own = { id: 'd2', prefix: 'sep', bucket: 'other', accessKeyId: 'k2', secretAccessKey: 's2', region: 'eu-west-1' };
  const keysOnly = { id: 'd3', prefix: 'keys', accessKeyId: 'k3', secretAccessKey: 's3' };

  test('driveStorageDiffers', () => {
    assert.equal(driveStorageDiffers(base, same), false);
    assert.equal(driveStorageDiffers(base, { prefix: 'x' }), false);
    assert.equal(driveStorageDiffers(base, own), true);
    assert.equal(driveStorageDiffers(base, keysOnly), true);
    assert.equal(driveStorageDiffers(base, null), false);
  });

  test('cfgForKey reaches an object with the storage of the drive holding it', () => {
    const drives = [same, own, keysOnly];
    assert.equal(cfgForKey(base, 'files/a.txt', drives), base, 'the library: unchanged');
    assert.equal(cfgForKey(base, 'team/a.txt', drives), base, 'a drive in the same bucket: unchanged');
    const sep = cfgForKey(base, 'sep/Cuts/a.mov', drives);
    assert.equal(sep.bucket, 'other');
    assert.equal(sep.accessKeyId, 'k2');
    assert.equal(cfgForKey(base, 'separate/a', drives), base, 'a prefix is a whole segment');
    assert.equal(cfgForKey(base, '', drives), base);
    assert.equal(cfgForKey(base, 'keys/a', drives).accessKeyId, 'k3');
  });

  test('the deepest drive holds a key', () => {
    const outer = { id: 'o', prefix: 'a', bucket: 'main' };
    const inner = { id: 'i', prefix: 'a/b', bucket: 'other', accessKeyId: 'x', secretAccessKey: 'y' };
    assert.equal(cfgForKey(base, 'a/b/c.txt', [outer, inner]).bucket, 'other');
    assert.equal(cfgForKey(base, 'a/c.txt', [outer, inner]), base);
  });
});
