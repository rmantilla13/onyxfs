// Recording a thumbnail: at upload through createFile, and afterwards through
// setFileThumbnail. Runs only with TEST_DATABASE_URL pointing at a throwaway
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

const KEY = '_thumbs/0f8fad5b-d9cb-469f-a165-70867728950e.webp';
const KEY2 = '_thumbs/7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg';

test('an upload is recorded with its kind, thumbnail and media facts, and a later thumbnail merges', { skip: !live && 'TEST_DATABASE_URL not reachable' }, async (t) => {
  const body = {
    name: 'interview.mp4', url: 'http://s3.test/b/files/interview.mp4', mime: 'video/mp4', size: 1000,
    storage: 's3', storageKey: 'files/interview.mp4', thumbnailKey: KEY,
    media: { width: 1920, height: 1080, duration: 42 }, metadata: { client: 'Acme' },
  };
  const file = await db.createFile({ ...body, ...uploadFields(body), createdBy: 'test@example.com' });
  t.after(async () => {
    await db.sql`DELETE FROM files WHERE id = ${file.id}`.catch(() => {});
    await db.sql.end({ timeout: 5 }).catch(() => {});
  });
  assert.equal(file.kind, 'video');
  assert.equal(file.thumbnailKey, KEY);
  assert.deepEqual(file.metadata, { client: 'Acme', width: 1920, height: 1080, duration: 42 });

  const after = await db.setFileThumbnail(file.id, KEY2, { width: 1280, height: 720 });
  assert.equal(after.thumbnailKey, KEY2);
  assert.equal(after.version, file.version, 'a poster is not an edit');
  assert.ok(after.seq > file.seq, 'sync clients hear about it');
  assert.deepEqual(after.metadata, { client: 'Acme', width: 1280, height: 720, duration: 42 });
  const [row] = await db.sql`SELECT jsonb_typeof(metadata) AS t, thumb_status FROM files WHERE id = ${file.id}`;
  assert.equal(row.t, 'object');
  assert.equal(row.thumb_status, 'ready');
});
