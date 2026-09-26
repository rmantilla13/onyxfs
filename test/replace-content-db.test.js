// New contents for a file, against a real database: the SQL behind
// lib/replace-content.js. Runs with TEST_DATABASE_URL pointing at a
// throwaway database, and skips without one, like the other database tests.
//
// What only a database can show: that an upload key is taken only for what
// it was issued for (replace_of, compared as SQL compares a NULL), that a
// resumable upload keeps its binding, and that replaceFileContent is one
// conditional UPDATE — the old bytes' previews and media facts gone, the
// library's fields kept, the transcript left stale, the change carried by
// the delta, and a file that moved or went to the trash left alone.
// test/mac-writes-api.test.js runs the routes over an in-memory store.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const URL_ = process.env.TEST_DATABASE_URL;
async function reachable(url) {
  if (!url) return false;
  const { default: postgres } = await import('postgres');
  const probe = postgres(url, { max: 1, connect_timeout: 3, idle_timeout: 1 });
  try { await probe`SELECT 1`; return true; } catch { return false; } finally { await probe.end({ timeout: 2 }).catch(() => {}); }
}
const live = await reachable(URL_);
process.env.DATABASE_URL = live ? URL_ : 'postgres://onyx:onyx@127.0.0.1:1/onyx';
process.env.ADMIN_EMAILS = 'boss@rc.test';
process.env.SCHEMA_MANAGED = '0';
const skip = !live && 'TEST_DATABASE_URL not reachable';

const db = await import('../lib/db.js');
const { MEDIA_KEYS } = await import('../lib/media.js');

const tag = Math.random().toString(36).slice(2, 8);
const ED = `ed-${tag}@rc.test`;
const OTHER = `other-${tag}@rc.test`;
const PREFIX = `rc-${tag}`;
const made = [];

before(async () => {
  if (!live) return;
  await db.ensureSchema();
});

after(async () => {
  if (live) {
    for (const id of made) await db.deleteFile(id).catch(() => {});
    await db.sql`DELETE FROM file_tombstones WHERE id = ANY(${made})`.catch(() => {});
    await db.sql`DELETE FROM upload_keys WHERE email IN (${ED}, ${OTHER})`.catch(() => {});
    await db.sql`DELETE FROM uploads WHERE created_by IN (${ED}, ${OTHER})`.catch(() => {});
  }
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

async function file(name, extra = {}) {
  const key = `${PREFIX}/Cuts/${name}`;
  const f = await db.createFile({
    name, url: `http://s3.test/b/${key}`, mime: 'video/quicktime', kind: 'video', size: 1000, storage: 's3', storageKey: key,
    createdBy: ED, contentHash: 'a'.repeat(32), ...extra,
  });
  made.push(f.id);
  return f;
}

describe('new contents against a real database', { skip }, () => {
  test('a key is taken only for what it was issued for, once', async () => {
    const f = await file('Keys.mov');
    const k = `${PREFIX}/Cuts/Keys (2).mov`;
    await db.issueUploadKey(k, ED, { bucket: 'b', replaceOf: f.id });
    assert.equal(await db.claimUploadKey(k, ED), null, 'not as a new file');
    assert.equal(await db.claimUploadKey(k, ED, { replaceOf: 'another-file' }), null, 'not into another file');
    assert.equal(await db.claimUploadKey(k, OTHER, { replaceOf: f.id }), null, 'not by someone else');
    assert.deepEqual(await db.claimUploadKey(k, ED, { replaceOf: f.id }), { bucket: 'b' });
    assert.equal(await db.claimUploadKey(k, ED, { replaceOf: f.id }), null, 'once');

    const plain = `${PREFIX}/Cuts/Plain.mov`;
    await db.issueUploadKey(plain, ED, { bucket: 'b' });
    assert.equal(await db.claimUploadKey(plain, ED, { replaceOf: f.id }), null, 'a new file’s key is not new contents');
    assert.deepEqual(await db.claimUploadKey(plain, ED), { bucket: 'b' });

    // Issued again (multipart `complete`): the latest purpose is the one.
    await db.issueUploadKey(k, ED, { bucket: 'b' });
    await db.issueUploadKey(k, ED, { bucket: 'b2', replaceOf: f.id });
    assert.deepEqual(await db.claimUploadKey(k, ED, { replaceOf: f.id }), { bucket: 'b2' });

    // Expired.
    await db.issueUploadKey(k, ED, { bucket: 'b', replaceOf: f.id });
    await db.sql`UPDATE upload_keys SET issued_at = ${Date.now() - db.UPLOAD_KEY_TTL_MS - 1} WHERE storage_key = ${k}`;
    assert.equal(await db.claimUploadKey(k, ED, { replaceOf: f.id }), null);
  });

  test('a key an upload in flight holds is passed over — except your own new file’s', async () => {
    const f = await file('Held.mov');
    const mine = `${PREFIX}/Cuts/Held-mine.mov`;
    const theirs = `${PREFIX}/Cuts/Held-theirs.mov`;
    const bound = `${PREFIX}/Cuts/Held (2).mov`;
    await db.issueUploadKey(mine, ED, { bucket: 'b' });
    await db.issueUploadKey(theirs, OTHER, { bucket: 'b' });
    await db.issueUploadKey(bound, ED, { bucket: 'b', replaceOf: f.id });
    assert.equal(await db.uploadKeyHeld(mine, { by: ED }), false, 'retrying your own upload keeps its name');
    assert.equal(await db.uploadKeyHeld(mine, { by: OTHER }), true);
    assert.equal(await db.uploadKeyHeld(theirs, { by: ED }), true);
    assert.equal(await db.uploadKeyHeld(bound, { by: ED }), true, 'new contents are never shared, even with yourself');
    assert.equal(await db.uploadKeyHeld(mine, { by: ED, forReplacement: true }), true, 'nor do new contents share anything');
    assert.equal(await db.uploadKeyHeld(`${PREFIX}/Cuts/nobody.mov`, { by: ED, forReplacement: true }), false);
    await db.claimUploadKey(theirs, OTHER);
    assert.equal(await db.uploadKeyHeld(theirs, { by: ED }), false, 'recorded: the bucket answers for it now');
    await db.sql`UPDATE upload_keys SET issued_at = ${Date.now() - db.UPLOAD_KEY_TTL_MS - 1} WHERE storage_key = ${bound}`;
    assert.equal(await db.uploadKeyHeld(bound, { by: OTHER }), false, 'expired');
  });

  test('a resumable upload keeps the file it is new contents for', async () => {
    const f = await file('Resume.mov');
    const up = await db.createUpload({
      uploadId: 'u1', storageKey: `${PREFIX}/Cuts/Resume (2).mov`, filename: 'Resume.mov', size: 5, partSize: 8388608, createdBy: ED, replaceOf: f.id,
    });
    assert.equal(up.replaceOf, f.id);
    assert.equal((await db.getUpload(up.id, ED)).replaceOf, f.id);
    assert.equal((await db.listUploads(ED)).find((u) => u.id === up.id).replaceOf, f.id);
    const plain = await db.createUpload({ uploadId: 'u2', storageKey: `${PREFIX}/x.mov`, filename: 'x.mov', size: 5, partSize: 8388608, createdBy: ED });
    assert.equal(plain.replaceOf, null);
    await db.deleteUpload(up.id);
    await db.deleteUpload(plain.id);
  });

  test('replaceFileContent: new bytes, the same file; what described the old ones goes', async () => {
    const f = await file('Swap.mov', {
      thumbnailKey: '_thumbs/11111111-1111-4111-8111-111111111111.webp', thumbSizes: ['sm', 'xs'],
      posterKey: '_thumbs/11111111-1111-4111-8111-111111111111.poster.webp',
      filmstripKey: '_thumbs/11111111-1111-4111-8111-111111111111.strip.webp',
      metadata: { client: 'Acme', width: 1920, height: 1080, duration: 9.5, fps: { num: 25, den: 1 }, frames: 237, filmstrip: { frames: 40 } },
      tags: ['keep'], notes: 'kept',
    });
    await db.markThumbStatus(f.id, 'ready');
    await db.requestTranscript(f.id, { requestedBy: ED });
    await db.claimTranscript(f.id, { email: ED, sourceKey: f.storageKey });
    const before = await db.getFileById(f.id);
    const cursor = await db.currentChangeCursor();

    const to = `${PREFIX}/Cuts/Swap (2).mov`;
    const out = await db.replaceFileContent(f.id, {
      fromKey: f.storageKey, toKey: to, url: `http://s3.test/b/${to}`, size: 2500, mime: 'video/mp4', kind: 'video', contentHash: 'b'.repeat(32),
    });
    assert.ok(out);
    assert.equal(out.id, f.id);
    assert.equal(out.name, 'Swap.mov');
    assert.equal(out.folder, before.folder);
    assert.equal(out.storageKey, to);
    assert.equal(out.url, `http://s3.test/b/${to}`);
    assert.equal(out.size, 2500);
    assert.equal(out.mime, 'video/mp4');
    assert.equal(out.contentHash, 'b'.repeat(32));
    assert.deepEqual([out.thumbnailKey, out.posterKey, out.filmstripKey, out.thumbSizes], [null, null, null, []]);
    for (const k of MEDIA_KEYS) assert.equal(k in out.metadata, false, k);
    assert.equal(out.metadata.client, 'Acme');
    assert.deepEqual(out.tags, ['keep']);
    assert.equal(out.notes, 'kept');
    assert.equal(out.createdBy, ED, 'still its uploader’s');
    assert.equal(out.version, before.version + 1);
    assert.ok(out.seq > before.seq);
    assert.ok(out.updatedAt >= before.updatedAt);
    const [status] = await db.sql`SELECT thumb_status FROM files WHERE id = ${f.id}`;
    assert.equal(status.thumb_status, null, 'free to be made again');
    assert.equal((await db.getTranscript(f.id)).sourceKey, f.storageKey, 'the transcript is of the old bytes, and says so');

    const feed = await db.listFileChanges({ cursor, principal: { email: 'boss@rc.test', isAdmin: true } });
    assert.ok(feed.changed.some((r) => r.id === f.id && r.storageKey === to && r.size === 2500), 'the delta carries it');

    // Without a mime, the type stays.
    const again = await db.replaceFileContent(f.id, { fromKey: to, toKey: f.storageKey, url: 'u', size: 10, contentHash: null });
    assert.equal(again.mime, 'video/mp4');
    assert.equal(again.kind, 'video');
    assert.equal(again.contentHash, null);
  });

  test('a file that moved on, or went to the trash, is left as it is', async () => {
    const f = await file('Guard.mov');
    assert.equal(await db.replaceFileContent(f.id, { fromKey: `${PREFIX}/Elsewhere/Guard.mov`, toKey: `${PREFIX}/Cuts/x.mov`, url: 'u', size: 1 }), null);
    await db.softDeleteFile(f.id, { deletedBy: ED });
    assert.equal(await db.replaceFileContent(f.id, { fromKey: f.storageKey, toKey: `${PREFIX}/Cuts/x.mov`, url: 'u', size: 1 }), null);
    const row = await db.getFileById(f.id);
    assert.equal(row.storageKey, f.storageKey);
    assert.equal(row.size, 1000);
    assert.equal(row.version, f.version);
  });
});
