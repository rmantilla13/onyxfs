// Moving the files outside every drive into one (POST /api/admin/library/move)
// against a real database: which files the move takes (listLooseFiles), the
// re-key that only lands on a file still where the copy was made from
// (moveLooseFile), the notes a stopped call left (folderMoveCopiesInto), and
// the one statement that carries the library's folders, links and stars into
// the drive after them (moveFoldersIntoDrive). Runs with TEST_DATABASE_URL
// pointing at a throwaway database, and skips without one, like the other
// database tests. The library is shared with whatever else runs against the
// same database, so the folders are moved from a scope of this test's own
// (`from`), and the files are asked about by id. test/library-move-api.test.js
// runs the route over an in-memory store.

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
process.env.ADMIN_EMAILS = 'boss@lm.test';
process.env.SCHEMA_MANAGED = '0';
const skip = !live && 'TEST_DATABASE_URL not reachable';

const db = await import('../lib/db.js');

const T = `lm${Math.random().toString(36).slice(2, 8)}`;
const k = (path) => `${T}/${path}`;
const DRIVE = `${T}-drive`;
const made = [];
const ED = `ed-${T}@lm.test`;
const BOSS = `boss-${T}@lm.test`;

before(async () => {
  if (!live) return;
  await db.ensureSchema();
});

after(async () => {
  if (live) {
    for (const id of made) await db.sql`DELETE FROM files WHERE id = ${id}`.catch(() => {});
    await db.sql`DELETE FROM folders WHERE filespace LIKE ${`${T}%`}`.catch(() => {});
    await db.sql`DELETE FROM folder_move_copies WHERE to_key LIKE ${`${T}%`}`.catch(() => {});
    await db.sql`DELETE FROM file_shares WHERE storage_prefix LIKE ${`${T}%`}`.catch(() => {});
    await db.sql`DELETE FROM folder_stars WHERE owner_email IN (${ED}, ${BOSS})`.catch(() => {});
    await db.sql`DELETE FROM collections WHERE drive_id LIKE ${`${T}%`}`.catch(() => {});
  }
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

async function file(key, extra = {}) {
  const f = await db.createFile({ name: key.slice(key.lastIndexOf('/') + 1), url: `http://s3.test/b/${key}`, size: 5, storage: 's3', storageKey: key, createdBy: ED, ...extra });
  made.push(f.id);
  return f;
}

/** Every file the move would take, paged through as the route pages (after, limit), keeping this test's own. */
async function looseIds(drivePrefixes) {
  const mine = new Set(made);
  const out = [];
  let after = '';
  for (;;) {
    const rows = await db.listLooseFiles({ drivePrefixes, after, limit: 500 });
    if (!rows.length) break;
    for (const r of rows) if (mine.has(r.id)) out.push(r);
    after = rows[rows.length - 1].id;
  }
  return out;
}

describe('the files outside every drive, against a real database', { skip }, () => {
  test('the move takes files in the bucket under no drive, and nothing a listing hides', async () => {
    const a = await file(k('Shoot/a.jpg'), { folder: 'Shoot' });
    await file(`${DRIVE}/b.jpg`);
    await file(k('_thumbs/x.webp'));
    await file(k('.DS_Store'));
    const trashed = await file(k('old.jpg'));
    await db.softDeleteFile(trashed.id, { trashKey: null });
    const blob = await db.createFile({ name: 'blob.jpg', url: 'https://blob.test/x', storage: 'blob', createdBy: ED });
    made.push(blob.id);
    // A row whose key is another's thumbnail is a preview, not a file.
    const pic = await file(k('thumb-legacy.webp'));
    const owner = await file(k('photo.jpg'));
    await db.sql`UPDATE files SET thumbnail_key = ${k('thumb-legacy.webp')} WHERE id = ${owner.id}`;

    const rows = await looseIds([DRIVE]);
    assert.deepEqual(rows.map((r) => r.id).sort(), [a.id, owner.id].sort(), 'not the drive’s, a preview, junk, the trash, Blob, or another’s thumbnail');
    const one = rows.find((r) => r.id === a.id);
    assert.deepEqual(one, { id: a.id, name: 'a.jpg', folder: 'Shoot', size: 5, storageKey: k('Shoot/a.jpg') });
    assert.ok(!rows.some((r) => r.id === pic.id));
    // Under a drive, a file is not the move's.
    assert.deepEqual(await looseIds([DRIVE, T]), []);

    const movable = await db.countLooseFiles({ drivePrefixes: [DRIVE] });
    const outside = await db.libraryUsage({ drivePrefixes: [DRIVE] });
    assert.ok(Number.isInteger(movable.files) && Number.isInteger(outside.files) && movable.files <= outside.files);
    assert.ok(movable.files >= 2 && outside.files >= 5);
    // With no drives at all, everything is outside them.
    assert.ok((await db.listLooseFiles({ drivePrefixes: [], limit: 1 })).length === 1);
    assert.ok((await db.libraryUsage({ drivePrefixes: [] })).files >= outside.files);
  });

  test('a re-key lands only on a file still live at the key it was copied from, and moves its seq', async () => {
    const f = await file(k('Cuts/a.mov'), { folder: 'Cuts' });
    await db.requestTranscript(f.id);
    await db.sql`UPDATE transcripts SET source_key = ${k('Cuts/a.mov')} WHERE file_id = ${f.id}`;
    await db.requestProxy(f.id);
    await db.sql`UPDATE proxies SET source_key = ${k('Cuts/a.mov')} WHERE file_id = ${f.id}`;
    const before = await db.getFileById(f.id);

    assert.equal(await db.moveLooseFile(f.id, { fromKey: k('elsewhere.mov'), toKey: `${DRIVE}/Cuts/a.mov`, folder: 'Cuts' }), false, 'not where it was copied from');
    assert.equal((await db.getFileById(f.id)).storageKey, k('Cuts/a.mov'));

    const to = `${DRIVE}/Old/Cuts/a (2).mov`;
    assert.equal(await db.moveLooseFile(f.id, { fromKey: k('Cuts/a.mov'), toKey: to, folder: 'Old/Cuts', name: 'a (2).mov', url: `http://s3.test/b/${to}` }), true);
    const now = await db.getFileById(f.id);
    assert.deepEqual([now.storageKey, now.folder, now.name, now.url], [to, 'Old/Cuts', 'a (2).mov', `http://s3.test/b/${to}`]);
    assert.equal(now.version, before.version + 1);
    assert.ok(Number(now.seq) > Number(before.seq));
    const [t] = await db.sql`SELECT source_key FROM transcripts WHERE file_id = ${f.id}`;
    const [p] = await db.sql`SELECT source_key FROM proxies WHERE file_id = ${f.id}`;
    assert.deepEqual([t.source_key, p.source_key], [to, to], 'its transcript and proxy follow');

    const gone = await file(k('gone.jpg'));
    await db.softDeleteFile(gone.id, { trashKey: null });
    assert.equal(await db.moveLooseFile(gone.id, { fromKey: k('gone.jpg'), toKey: `${DRIVE}/gone.jpg` }), false, 'not one in the trash');
  });

  test('the notes into a drive, and only those', async () => {
    await db.noteFolderMoveCopies([
      { fromKey: k('a'), toKey: `${DRIVE}/a` },
      { fromKey: k('b'), toKey: `${DRIVE}/Shoot/b` },
      { fromKey: k('c'), toKey: `${DRIVE}x/c` },
    ]);
    const notes = await db.folderMoveCopiesInto(DRIVE);
    assert.deepEqual(notes.map((n) => [n.toKey, n.fromKey]).sort(), [[`${DRIVE}/Shoot/b`, k('b')], [`${DRIVE}/a`, k('a')]]);
  });
});

describe('the library’s folders following its files, against a real database', { skip }, () => {
  const FROM = { tag: `${T}lib`, driveId: `${T}libd` };
  const TO = { tag: `${T}drv`, driveId: `${T}d1` };
  const namesIn = async (tag) => (await db.sql`SELECT name, parent, depth FROM folders WHERE filespace = ${tag} ORDER BY name`)
    .map((r) => [r.name, r.parent, r.depth]);

  test('folder rows with their tags, links and stars move in one statement; again, nothing changes', async () => {
    await db.setFolderMeta('Shoot', { tag: FROM.tag, tags: ['spring'], metadata: { client: 'Acme', season: 'Spring' } });
    await db.createFolder('Shoot/Day 1', { filespace: FROM.tag });
    await db.createFolder('Empty', { filespace: FROM.tag });
    await db.setFolderMeta('Old/Shoot', { tag: TO.tag, tags: ['team'], metadata: { client: 'Ours' } });
    const link = await db.createFolderShare({ folder: 'Shoot', storagePrefix: FROM.tag, createdBy: ED });
    await db.setFolderStar(ED, { driveId: FROM.driveId, folder: 'Shoot/Day 1', starred: true });
    await db.setFolderStar(BOSS, { driveId: FROM.driveId, folder: 'Shoot', starred: true });
    await db.setFolderStar(BOSS, { driveId: TO.driveId, folder: 'Old/Shoot', starred: true });

    const out = await db.moveFoldersIntoDrive({ tag: TO.tag, driveId: TO.driveId, under: 'Old', createdBy: BOSS, from: FROM });
    assert.deepEqual(out, { folders: 3, links: 1, stars: 2 });
    assert.deepEqual(await namesIn(FROM.tag), []);
    assert.deepEqual(await namesIn(TO.tag), [
      ['Old', '', 1], ['Old/Empty', 'Old', 2], ['Old/Shoot', 'Old', 2], ['Old/Shoot/Day 1', 'Old/Shoot', 3],
    ]);
    const meta = await db.listFolderMeta(TO.tag);
    assert.deepEqual(meta.get('Old/Shoot'), { tags: ['spring', 'team'], metadata: { client: 'Ours', season: 'Spring' } });
    const row = await db.getShareRow(link.token);
    assert.deepEqual([row.storage_prefix, row.folder], [TO.tag, 'Old/Shoot']);
    assert.deepEqual((await db.listFolderStars(ED)).map((s) => [s.driveId, s.folder]), [[TO.driveId, 'Old/Shoot/Day 1']]);
    assert.deepEqual((await db.listFolderStars(BOSS)).map((s) => [s.driveId, s.folder]), [[TO.driveId, 'Old/Shoot']]);

    const again = await db.moveFoldersIntoDrive({ tag: TO.tag, driveId: TO.driveId, under: 'Old', createdBy: BOSS, from: FROM });
    assert.deepEqual(again, { folders: 0, links: 0, stars: 0 });
    assert.equal((await namesIn(TO.tag)).length, 4);
  });

  test('to the top of the drive, and a collection moved under a name of its own', async () => {
    const from = { tag: `${T}lib2`, driveId: `${T}libd2` };
    await db.createFolder('A/B', { filespace: from.tag });
    const out = await db.moveFoldersIntoDrive({ tag: `${T}drv2`, driveId: `${T}d2`, from });
    assert.equal(out.folders, 2);
    assert.deepEqual((await namesIn(`${T}drv2`)).map((r) => r[0]), ['A', 'A/B']);

    const c = await db.createCollection({ name: 'Selects', driveId: from.driveId, rules: [{ field: 'kind', op: 'any', values: ['image'] }] });
    const moved = await db.moveCollection(c.id, { driveId: `${T}d2`, name: 'Selects (2)' });
    assert.deepEqual([moved.driveId, moved.name, moved.rules], [`${T}d2`, 'Selects (2)', c.rules]);
  });
});
