// A file's own dates against a real database: kept beside the row's own
// times, read back through every way a file row leaves the server — the
// record, one file, the listing, the change feed — and moved with the bytes
// when new contents are swapped in. Runs with TEST_DATABASE_URL pointing at a
// throwaway database, and skips without one. How the listing sorts on them is
// test/file-sort.test.js's.

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
process.env.SCHEMA_MANAGED = '0';
const skip = !live && 'TEST_DATABASE_URL not reachable';

const db = await import('../lib/db.js');

const T = `dates${Math.random().toString(36).slice(2, 8)}`;
const ADMIN = { email: 'boss@dates.test', isAdmin: true };
const SHOT = Date.parse('2026-09-05T12:30:00Z');
const SAVED = Date.parse('2026-09-05T13:02:10Z');
const made = [];

before(async () => {
  if (live) await db.ensureSchema();
});

after(async () => {
  if (live) {
    for (const id of made) await db.deleteFile(id).catch(() => {});
    await db.sql`DELETE FROM file_tombstones WHERE id = ANY(${made})`.catch(() => {});
  }
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

async function file(name, dates = {}) {
  const key = `${T}/${name}`;
  const f = await db.createFile({ name, url: `http://s3.test/b/${key}`, size: 10, folder: T, storage: 's3', storageKey: key, createdBy: 'ed@dates.test', ...dates });
  made.push(f.id);
  return f;
}

describe('a file’s own dates, against a real database', { skip }, () => {
  test('two nullable columns beside the row’s times', async () => {
    const cols = await db.sql`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'files' AND column_name IN ('file_created_at', 'file_modified_at') ORDER BY column_name`;
    assert.deepEqual(cols.map((c) => [c.column_name, c.data_type, c.is_nullable]), [
      ['file_created_at', 'bigint', 'YES'], ['file_modified_at', 'bigint', 'YES'],
    ]);
  });

  test('recorded, and read back by one file, the listing and the change feed', async () => {
    const cursor = await db.currentChangeCursor();
    const f = await file('Take 1.mov', { fileCreatedAt: SHOT, fileModifiedAt: SAVED });
    const plain = await file('Notes.txt');
    assert.deepEqual([f.fileCreatedAt, f.fileModifiedAt], [SHOT, SAVED]);
    assert.ok(f.createdAt > SAVED, 'the row’s own time is when it was added');
    assert.deepEqual([plain.fileCreatedAt, plain.fileModifiedAt], [null, null], 'none said, none kept');

    const one = await db.getFileById(f.id);
    assert.deepEqual([one.fileCreatedAt, one.fileModifiedAt], [SHOT, SAVED]);

    const { files } = await db.listFilesForUser({ folder: T, sort: 'name' }, ADMIN);
    const listed = Object.fromEntries(files.map((x) => [x.name, [x.fileCreatedAt, x.fileModifiedAt]]));
    assert.deepEqual(listed, { 'Take 1.mov': [SHOT, SAVED], 'Notes.txt': [null, null] });

    const feed = await db.listFileChanges({ cursor, principal: ADMIN });
    const changed = feed.changed.find((x) => x.id === f.id);
    assert.deepEqual([changed.fileCreatedAt, changed.fileModifiedAt], [SHOT, SAVED]);
  });

  test('new contents move the modified date, to the one given or to now, and keep the created one', async () => {
    const f = await file('Cut.mov', { fileCreatedAt: SHOT, fileModifiedAt: SAVED });
    const later = Date.parse('2026-09-06T08:00:00Z');
    const given = await db.replaceFileContent(f.id, { fromKey: f.storageKey, toKey: `${T}/Cut (2).mov`, url: 'u', size: 20, fileModifiedAt: later });
    assert.deepEqual([given.fileCreatedAt, given.fileModifiedAt], [SHOT, later]);
    assert.ok(given.seq > f.seq, 'and the feed carries it');

    const before = Date.now();
    const unsaid = await db.replaceFileContent(f.id, { fromKey: given.storageKey, toKey: `${T}/Cut.mov`, url: 'u', size: 30 });
    assert.ok(unsaid.fileModifiedAt >= before && unsaid.fileModifiedAt <= Date.now(), 'now, when the new contents said nothing');
    assert.equal(unsaid.fileModifiedAt, unsaid.updatedAt, 'the same now as the row’s');
    assert.equal(unsaid.fileCreatedAt, SHOT);

    // A file recorded without dates gets its first modified date from its first new contents.
    const plain = await file('Plain.bin');
    const swapped = await db.replaceFileContent(plain.id, { fromKey: plain.storageKey, toKey: `${T}/Plain (2).bin`, url: 'u', size: 1 });
    assert.equal(swapped.fileCreatedAt, null);
    assert.ok(swapped.fileModifiedAt > 0);
  });

  test('a rename or move is no change to the file’s own dates', async () => {
    const f = await file('Still.mov', { fileCreatedAt: SHOT, fileModifiedAt: SAVED });
    const renamed = await db.updateFile(f.id, { name: 'Still 2.mov', folder: `${T}/Moved` });
    assert.deepEqual([renamed.fileCreatedAt, renamed.fileModifiedAt], [SHOT, SAVED]);
    assert.ok(renamed.updatedAt >= f.updatedAt);
  });
});
