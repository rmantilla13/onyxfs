// A folder rename's noted copies (folder_move_copies), and which keys a file
// holds (storageKeysInUse), against a real database: the SQL that lets
// PATCH /api/files/folders carry on from a call that stopped part-way, and
// never undo a copy a file has come to point at. Runs with TEST_DATABASE_URL
// pointing at a throwaway database, and skips without one, like the other
// database tests. test/mac-writes-api.test.js runs the route over an
// in-memory store.

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
process.env.ADMIN_EMAILS = 'boss@fs.test';
process.env.SCHEMA_MANAGED = '0';
const skip = !live && 'TEST_DATABASE_URL not reachable';

const db = await import('../lib/db.js');

const T = `mc${Math.random().toString(36).slice(2, 8)}`;
const k = (path) => `${T}/${path}`;
const made = [];

before(async () => {
  if (!live) return;
  await db.ensureSchema();
});

after(async () => {
  if (live) {
    for (const id of made) await db.sql`DELETE FROM files WHERE id = ${id}`.catch(() => {});
    await db.sql`DELETE FROM folder_move_copies WHERE to_key LIKE ${`${T}/%`}`.catch(() => {});
  }
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

async function file(key) {
  const f = await db.createFile({ name: 'f.arw', url: `http://s3.test/b/${key}`, size: 1, folder: T, storage: 's3', storageKey: key, createdBy: 'x@fs.test' });
  made.push(f.id);
  return f;
}

describe('a folder rename’s copies, against a real database', { skip }, () => {
  test('noted, found, noted over by another rename, and forgotten', async () => {
    await db.noteFolderMoveCopies([
      { fromKey: k('Shoot/a'), toKey: k('2026/Shoot/a') },
      { fromKey: k('Shoot/b'), toKey: k('2026/Shoot/b') },
      { fromKey: null, toKey: k('2026/Shoot/x') },
    ]);
    assert.deepEqual(
      await db.folderMoveCopiesAt([k('2026/Shoot/a'), k('2026/Shoot/b'), k('2026/Shoot/c'), k('2026/Shoot/x')]),
      new Map([[k('2026/Shoot/a'), k('Shoot/a')], [k('2026/Shoot/b'), k('Shoot/b')]]),
    );
    // The same new key, noted by a rename of another folder.
    await db.noteFolderMoveCopies([{ fromKey: k('Old/Shoot/a'), toKey: k('2026/Shoot/a') }]);
    assert.equal((await db.folderMoveCopiesAt([k('2026/Shoot/a')])).get(k('2026/Shoot/a')), k('Old/Shoot/a'));

    await db.forgetFolderMoveCopies([k('2026/Shoot/a'), k('2026/Shoot/b')]);
    assert.equal((await db.folderMoveCopiesAt([k('2026/Shoot/a'), k('2026/Shoot/b')])).size, 0);
    // Nothing to do: nothing asked.
    await db.noteFolderMoveCopies([]);
    await db.forgetFolderMoveCopies([]);
    assert.equal((await db.folderMoveCopiesAt([])).size, 0);
  });

  test('the keys files hold: live, in the trash where they were, or moved to the trash', async () => {
    await file(k('live'));
    const unmoved = await file(k('unmoved'));
    await db.softDeleteFile(unmoved.id, { trashKey: null });
    const moved = await file(k('moved'));
    await db.softDeleteFile(moved.id, { trashKey: k('_trash/moved') });

    const keys = [k('live'), k('unmoved'), k('moved'), k('_trash/moved'), k('free')];
    const held = await db.storageKeysInUse([...keys, null, k('live')]);
    assert.deepEqual([...held].sort(), [k('_trash/moved'), k('live'), k('unmoved')].sort());
    for (const key of keys) assert.equal(held.has(key), await db.storageKeyInUse(key), `as storageKeyInUse decides ${key}`);
    assert.equal((await db.storageKeysInUse([])).size, 0);
  });
});
