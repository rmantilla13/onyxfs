// What POST /api/files takes from a client (lib/file-record.js). The route
// used to spread the whole body into createFile, which honours createdAt,
// updatedAt and contentHash — so a client could backdate a file or claim a
// hash, and be counted a duplicate of something it is not.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { parseFileRecord, FILE_VISIBILITIES } = await import('../lib/file-record.js');

const base = { url: 'https://bucket.example/files/a.jpg', storage: 's3', storageKey: 'files/a.jpg', name: 'a.jpg' };

describe('parseFileRecord', () => {
  test('fields the server decides never pass through', () => {
    const { record } = parseFileRecord({
      ...base,
      createdBy: 'someone-else@example.com',
      createdAt: 1, updatedAt: 1,
      contentHash: 'deadbeef',
      id: 'chosen-id', seq: 1, version: 99,
      deletedAt: 5, trashKey: '_trash/x',
      thumbnailUrl: 'https://evil.example/x.jpg',
    });
    for (const k of ['createdBy', 'createdAt', 'updatedAt', 'contentHash', 'id', 'seq', 'version', 'deletedAt', 'trashKey', 'thumbnailUrl']) {
      assert.equal(k in record, false, `${k} reached the record`);
    }
  });

  test('visibility is org or owner, org by default', () => {
    assert.deepEqual(FILE_VISIBILITIES, ['org', 'owner']);
    assert.equal(parseFileRecord(base).record.visibility, 'org');
    assert.equal(parseFileRecord({ ...base, visibility: 'owner' }).record.visibility, 'owner');
    // 'custom' needs a list of people, which only the ACL route carries.
    for (const v of ['custom', 'public', '', 'ORG']) {
      assert.match(parseFileRecord({ ...base, visibility: v }).error || '', /Visibility/, String(v));
    }
  });

  test('an S3 row needs its key, and the key cannot be ours', () => {
    assert.match(parseFileRecord({ ...base, storageKey: undefined }).error, /storage key/);
    assert.match(parseFileRecord({ ...base, storageKey: '_thumbs/x.webp' }).error, /Not a file key/);
    assert.match(parseFileRecord({ ...base, storageKey: '_trash/f1/files/a.jpg' }).error, /Not a file key/);
  });

  test('a url is required and storage is s3 or blob', () => {
    assert.match(parseFileRecord({ ...base, url: '' }).error, /URL/);
    assert.match(parseFileRecord({ ...base, storage: 'ftp' }).error, /storage/i);
    assert.equal(parseFileRecord({ url: 'https://blob.example/a' }).record.storage, 'blob');
  });

  test('size is a whole, non-negative number of bytes', () => {
    assert.equal(parseFileRecord({ ...base, size: '2048' }).record.size, 2048);
    assert.equal(parseFileRecord({ ...base }).record.size, null);
    assert.match(parseFileRecord({ ...base, size: -1 }).error, /Size/);
    assert.match(parseFileRecord({ ...base, size: 'lots' }).error, /Size/);
  });

  test('not an object is a bad request', () => {
    for (const b of [null, [], 'x', 7]) assert.equal(parseFileRecord(b).error, 'Bad request');
  });
});
