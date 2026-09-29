// Recording a sound's waveform against a real database: at upload through
// createFile, afterwards through setFileWaveform, and gone with the contents
// it was drawn from. Runs only with TEST_DATABASE_URL pointing at a
// throwaway database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uploadFields } from '../lib/media.js';
import { encodeWaveform } from '../lib/waveform.js';

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

const WAVE = encodeWaveform(Uint8Array.from({ length: 256 }, (_, i) => i));
const WAVE2 = encodeWaveform(Uint8Array.from({ length: 256 }, (_, i) => 255 - i));

test.after(async () => { await db.sql.end({ timeout: 5 }).catch(() => {}); });

test('a sound keeps the waveform drawn at upload, and takes a later one without it being an edit', { skip: !live && 'TEST_DATABASE_URL not reachable' }, async (t) => {
  const body = {
    name: 'take.m4a', url: 'http://s3.test/b/files/take.m4a', mime: 'audio/mp4', size: 1000,
    storage: 's3', storageKey: `files/take-${Date.now()}.m4a`, contentHash: 'etag-1', waveform: WAVE,
    media: { duration: 30 }, metadata: { client: 'Acme' },
  };
  const file = await db.createFile({ ...body, ...uploadFields(body), createdBy: 'test@example.com' });
  t.after(async () => { await db.sql`DELETE FROM files WHERE id = ${file.id}`.catch(() => {}); });
  assert.deepEqual(file.metadata, { client: 'Acme', duration: 30, waveform: WAVE });

  await db.sql`UPDATE files SET updated_at = 1000 WHERE id = ${file.id}`;
  const after = await db.setFileWaveform(file.id, WAVE2, { contentHash: 'etag-1' });
  assert.equal(after.metadata.waveform, WAVE2);
  assert.equal(after.metadata.client, 'Acme', 'merged, not replaced');
  assert.equal(after.version, file.version, 'not an edit');
  assert.equal(after.updatedAt, 1000, 'nor a modification');
  assert.ok(after.seq > file.seq, 'devices hear about it');

  assert.equal(await db.setFileWaveform(file.id, WAVE, { contentHash: 'etag-2' }), 'changed', 'drawn from other contents');
  assert.equal((await db.getFileById(file.id)).metadata.waveform, WAVE2);
  assert.equal((await db.setFileWaveform(file.id, WAVE)).metadata.waveform, WAVE, 'no hash, no condition');

  // New contents take every media fact with them — the waveform included.
  const swapped = await db.replaceFileContent(file.id, {
    fromKey: body.storageKey, toKey: `${body.storageKey}.v2`, url: body.url, size: 2000, contentHash: 'etag-2',
  });
  assert.equal(swapped.metadata.waveform, undefined);
  assert.equal(swapped.metadata.client, 'Acme');

  await db.sql`UPDATE files SET deleted_at = ${Date.now()} WHERE id = ${file.id}`;
  assert.equal(await db.setFileWaveform(file.id, WAVE), null, 'not for a trashed file');
  assert.equal(await db.setFileWaveform(file.id, WAVE, { contentHash: 'etag-2' }), null);
  assert.equal(await db.setFileWaveform('00000000-0000-0000-0000-000000000000', WAVE), null);
});
