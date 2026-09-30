// A thumbnail's placeholder against a real database: recorded with its
// thumbnail, replaced with it, and recorded later only for the thumbnail it
// was drawn from. Runs only with TEST_DATABASE_URL pointing at a throwaway
// database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uploadFields } from '../lib/media.js';

const URL_ = process.env.TEST_DATABASE_URL;

async function reachable(url) {
  if (!url) return false;
  const { default: postgres } = await import('postgres');
  const probe = postgres(url, { max: 1, connect_timeout: 3, idle_timeout: 1 });
  try { await probe`SELECT 1`; return true; }
  catch { return false; }
  finally { await probe.end({ timeout: 2 }).catch(() => {}); }
}
const live = await reachable(URL_);
process.env.DATABASE_URL = live ? URL_ : 'postgres://onyx:onyx@127.0.0.1:1/onyx';
const db = await import('../lib/db.js');

const PH = 'data:image/webp;base64,UklGRkQAAABXRUJQVlA4IDgAAAAQAwCdASoYABIAPtFiqk+oJaOiKAgBABoJZQDKABanFAAA/uX6P+HPtj97JX/VR2OO4YxZAAAAAA==';
const PH2 = `data:image/jpeg;base64,${btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0, 16))}`;
const KEY = '_thumbs/0f8fad5b-d9cb-469f-a165-70867728950e.webp';
const KEY2 = '_thumbs/7c9e6679-7425-40de-944b-e07fc1f90ae7.webp';

test.after(async () => { await db.sql.end({ timeout: 5 }).catch(() => {}); });

test('a placeholder rides with its thumbnail, goes with it, and comes later only for the one it copies', { skip: !live && 'TEST_DATABASE_URL not reachable' }, async (t) => {
  const body = {
    name: 'still.jpg', url: 'http://s3.test/b/files/still.jpg', mime: 'image/jpeg', size: 1000,
    storage: 's3', storageKey: `files/still-${Date.now()}.jpg`, thumbnailKey: KEY, placeholder: PH,
    media: { width: 4000, height: 3000 }, metadata: { client: 'Acme' },
  };
  const file = await db.createFile({ ...body, ...uploadFields(body), createdBy: 'test@example.com' });
  t.after(async () => { await db.sql`DELETE FROM files WHERE id = ${file.id}`.catch(() => {}); });
  assert.equal(file.metadata.placeholder, PH);

  const without = await db.setFileThumbnail(file.id, KEY2, { width: 4000, height: 3000 });
  assert.equal(without.metadata.placeholder, undefined, 'the old thumbnail’s placeholder went with it');
  assert.equal(without.metadata.client, 'Acme');

  await db.sql`UPDATE files SET updated_at = 1000 WHERE id = ${file.id}`;
  assert.equal(await db.setFilePlaceholder(file.id, PH2, { thumbnailKey: KEY }), 'changed', 'drawn from the thumbnail before');
  const later = await db.setFilePlaceholder(file.id, PH2, { thumbnailKey: KEY2 });
  assert.equal(later.metadata.placeholder, PH2);
  assert.equal(later.version, without.version, 'not an edit');
  assert.equal(later.updatedAt, 1000, 'nor a modification');
  assert.ok(later.seq > without.seq, 'listings and devices hear about it');

  const again = await db.setFileThumbnail(file.id, KEY, {}, null, null, { placeholder: PH });
  assert.equal(again.metadata.placeholder, PH, 'a new thumbnail’s own');

  await db.sql`UPDATE files SET deleted_at = ${Date.now()} WHERE id = ${file.id}`;
  assert.equal(await db.setFilePlaceholder(file.id, PH, { thumbnailKey: KEY }), null, 'not for a trashed file');
});
