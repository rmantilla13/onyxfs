// The daily trash purge deleted a trashed file's OLD key. Trashing moves the
// object to `_trash/<id>/<key>`, so that key was empty — until someone
// uploaded a file of the same name to the same folder, which the purge then
// deleted, thirty days later, while the trashed copy stayed in the bucket
// for ever. purgeTarget decides what is deleted; these pin it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { purgeTarget } = await import('../lib/db.js');

const row = (over = {}) => ({
  id: 'f1', storage: 's3', storageKey: 'files/Campaigns/hero.jpg',
  trashKey: '_trash/f1/files/Campaigns/hero.jpg', ...over,
});

test('the trashed copy is deleted, not the old key', () => {
  assert.equal(purgeTarget(row()), '_trash/f1/files/Campaigns/hero.jpg');
});

test('the old key is never deleted when a trash copy exists, even if unused', () => {
  assert.equal(purgeTarget(row(), { keyInUse: false }), '_trash/f1/files/Campaigns/hero.jpg');
});

test('a row trashed without a move deletes its own key only when nothing else uses it', () => {
  assert.equal(purgeTarget(row({ trashKey: null }), { keyInUse: false }), 'files/Campaigns/hero.jpg');
  assert.equal(purgeTarget(row({ trashKey: null }), { keyInUse: true }), null);
});

test('nothing in a bucket to delete is nothing', () => {
  assert.equal(purgeTarget(row({ trashKey: null, storage: 'blob', storageKey: null })), null);
  assert.equal(purgeTarget(row({ trashKey: null, storageKey: null })), null);
  assert.equal(purgeTarget(null), null);
});

test('the cron route deletes what purgeTarget names, not row.storageKey', async () => {
  const src = await readFile(new URL('../app/api/cron/maintenance/route.js', import.meta.url), 'utf8');
  assert.ok(!/s3DeleteObject\(cfg,\s*row\.storageKey\)/.test(src), 'purge must not delete the old key directly');
  assert.ok(/purgeTarget\(row/.test(src), 'purge goes through purgeTarget');
});

test('POST /api/files requires a storage key for an S3 row', async () => {
  // Without one the listing signs a key read out of `url`, which the drive
  // check never sees: a row could name any object in the bucket.
  const src = await readFile(new URL('../app/api/files/route.js', import.meta.url), 'utf8');
  const post = src.slice(src.indexOf('export async function POST'));
  const guard = post.indexOf("body.storage === 's3' && !body.storageKey");
  assert.ok(guard > 0, 'POST must refuse an S3 row without a storage key');
  assert.ok(guard < post.indexOf('createFile('), 'refused before the row is written');
});
