// Moving the files outside every drive into one (POST /api/admin/library/move)
// against a real database: which files the move takes (listLooseFiles), the
// re-key that only lands on a file still where the copy was made from and on
// a key no other file holds (moveLooseFile), the notes a stopped call left
// and the claim on a key (libraryMoveNotes, claimFolderMoveCopy), the lease
// that lets one call run at a time (claimLibraryMove), and the one statement
// that carries the library's folders, links and stars into the drive after
// them (moveFoldersIntoDrive). Runs with TEST_DATABASE_URL
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
const { folderLandings, landingPath, heldFolders } = await import('../lib/library-move.js');

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
    await db.sql`DELETE FROM settings WHERE key = 'library.move' AND value ->> 'by' LIKE ${`%${T}%`}`.catch(() => {});
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

  test('private files are asked about apart from the rest', async () => {
    const open = await file(k('Vis/open.jpg'), { folder: 'Vis' });
    const mine = await file(k('Vis/mine.jpg'), { folder: 'Vis', visibility: 'owner' });
    const theirs = await file(k('Vis/theirs.jpg'), { folder: 'Vis', visibility: 'custom' });
    const ids = async (visibility) => {
      const out = [];
      for (let after = ''; ;) {
        const rows = await db.listLooseFiles({ drivePrefixes: [DRIVE], after, limit: 500, visibility });
        if (!rows.length) break;
        out.push(...rows.map((r) => r.id).filter((id) => [open.id, mine.id, theirs.id].includes(id)));
        after = rows[rows.length - 1].id;
      }
      return out.sort();
    };
    assert.deepEqual(await ids('org'), [open.id]);
    assert.deepEqual(await ids('restricted'), [mine.id, theirs.id].sort());
    assert.deepEqual(await ids(null), [open.id, mine.id, theirs.id].sort());
    const all = await db.countLooseFiles({ drivePrefixes: [DRIVE] });
    const org = await db.countLooseFiles({ drivePrefixes: [DRIVE], visibility: 'org' });
    const restricted = await db.countLooseFiles({ drivePrefixes: [DRIVE], visibility: 'restricted' });
    assert.equal(org.files + restricted.files, all.files);
  });

  test('every drive’s prefix, however many there are', async () => {
    const drives = await db.listDrivePrefixes();
    assert.ok(Array.isArray(drives));
    for (const d of drives) assert.deepEqual(Object.keys(d).sort(), ['id', 'name', 'prefix']);
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

    // Never onto a key another file holds, whatever picked it.
    const there = await file(`${DRIVE}/taken.jpg`);
    const late = await file(k('taken.jpg'));
    assert.equal(await db.moveLooseFile(late.id, { fromKey: k('taken.jpg'), toKey: `${DRIVE}/taken.jpg` }), false);
    assert.equal((await db.getFileById(late.id)).storageKey, k('taken.jpg'));
    assert.equal((await db.getFileById(there.id)).storageKey, `${DRIVE}/taken.jpg`);
  });

  test('the notes moves into a drive left, and only those; a key is noted for one copy at a time', async () => {
    await db.noteFolderMoveCopies([
      { fromKey: k('a'), toKey: `${DRIVE}/a` },
      { fromKey: k('b'), toKey: `${DRIVE}/Shoot/b` },
      { fromKey: k('c'), toKey: `${DRIVE}x/c` },
      // A rename's, within the drive: not the move's.
      { fromKey: `${DRIVE}/Old/d`, toKey: `${DRIVE}/New/d` },
    ]);
    const mine = (notes) => notes.filter((n) => n.toKey.startsWith(`${DRIVE}/`)).map((n) => [n.toKey, n.fromKey]);
    const notes = await db.libraryMoveNotes({ drivePrefixes: [DRIVE] });
    // In the order the database's collation gives, which the paging follows: compared as a set.
    const got = mine(notes);
    assert.deepEqual([...got].sort(), [[`${DRIVE}/Shoot/b`, k('b')], [`${DRIVE}/a`, k('a')]].sort());
    assert.ok(notes.every((n) => Number.isFinite(n.notedAt) && n.notedAt > 0));
    const paged = await db.libraryMoveNotes({ drivePrefixes: [DRIVE], after: got[0][0] });
    assert.deepEqual(mine(paged), got.slice(1), 'the next page, after the first');

    assert.equal(await db.claimFolderMoveCopy({ fromKey: k('e'), toKey: `${DRIVE}/e` }), true, 'a new key');
    assert.equal(await db.claimFolderMoveCopy({ fromKey: k('e'), toKey: `${DRIVE}/e` }), true, 'the same copy again');
    assert.equal(await db.claimFolderMoveCopy({ fromKey: k('f'), toKey: `${DRIVE}/e` }), false, 'another file’s');
    assert.equal(await db.claimFolderMoveCopy({ fromKey: k('f'), toKey: `${DRIVE}/New/d` }), false, 'a rename’s');
    assert.equal((await db.folderMoveCopiesAt([`${DRIVE}/e`])).get(`${DRIVE}/e`), k('e'));

    // A rename in the drive takes over its own notes and another rename's,
    // never one the move made from outside the drive.
    const refused = await db.claimFolderMoveCopies([
      { fromKey: `${DRIVE}/Other/d`, toKey: `${DRIVE}/New/d` },
      { fromKey: `${DRIVE}/Other/e`, toKey: `${DRIVE}/e` },
      { fromKey: `${DRIVE}/Other/g`, toKey: `${DRIVE}/g` },
    ], { within: `${DRIVE}/` });
    assert.deepEqual(refused, [`${DRIVE}/e`]);
    const now = await db.folderMoveCopiesAt([`${DRIVE}/New/d`, `${DRIVE}/e`, `${DRIVE}/g`]);
    assert.deepEqual([now.get(`${DRIVE}/New/d`), now.get(`${DRIVE}/e`), now.get(`${DRIVE}/g`)], [`${DRIVE}/Other/d`, k('e'), `${DRIVE}/Other/g`]);
  });

  test('the folders files outside every drive are in, and which paths a drive has in use', async () => {
    await file(k('Kept/Deep/a.jpg'), { folder: 'Kept/Deep' });
    await file(k('Junk/.DS_Store'), { folder: 'Junk' });
    const blob = await db.createFile({ name: 'b.jpg', url: 'https://blob.test/b', storage: 'blob', folder: `${T}-Blob`, createdBy: ED });
    made.push(blob.id);
    await file(`${DRIVE}/Theirs/c.jpg`, { folder: `${T}-Theirs` });
    const outside = await db.foldersOutsideDrives({ drivePrefixes: [DRIVE] });
    assert.ok(outside.includes('Kept/Deep') && outside.includes(`${T}-Blob`), 'a file in the bucket, and one in Blob');
    assert.ok(!outside.includes('Junk'), 'not the OS’s junk');
    assert.ok(!outside.includes(`${T}-Theirs`), 'not a drive’s');

    await db.createFolder('Has/Row', { filespace: DRIVE });
    await file(`${DRIVE}/Files_100%/x.jpg`, { folder: 'Files_100%' });
    const used = await db.folderPathsInUse(['Has', 'Has/Row', 'Files_100%', 'Files_1000', 'Free', `${T}-Theirs`], { tag: DRIVE, prefix: DRIVE });
    assert.deepEqual([...used].sort(), ['Files_100%', 'Has', 'Has/Row', `${T}-Theirs`].sort());
  });

  test('one call holds the lease at a time; it keeps what the run decided, and lets go', async () => {
    const by = `boss-${T}@lm.test`;
    await db.sql`DELETE FROM settings WHERE key = 'library.move'`;
    const first = await db.claimLibraryMove({ call: `${T}-1`, by, ms: 60_000 });
    assert.deepEqual(first, {});
    assert.equal(await db.claimLibraryMove({ call: `${T}-2`, by, ms: 60_000 }), null, 'held');
    assert.equal(await db.updateLibraryMove(`${T}-1`, { run: { driveId: 'd1', under: '', carry: ['x'] } }), true);
    assert.equal(await db.updateLibraryMove(`${T}-2`, { until: Date.now() + 60_000 }), false, 'only by its holder');
    assert.equal(await db.updateLibraryMove(`${T}-1`, { until: 0 }), true);
    const second = await db.claimLibraryMove({ call: `${T}-2`, by, ms: 60_000 });
    assert.deepEqual(second.run, { driveId: 'd1', under: '', carry: ['x'] }, 'the run, for the next call');
    assert.equal(await db.updateLibraryMove(`${T}-2`, { run: null }), true);
    // Run out, it is anyone's.
    await db.sql`UPDATE settings SET value = value || '{"until": 1}'::jsonb WHERE key = 'library.move'`;
    const third = await db.claimLibraryMove({ call: `${T}-3`, by, ms: 60_000 });
    assert.ok(third && !('run' in third));
    assert.equal(await db.libraryMoveRun(), null);
    assert.equal(await db.updateLibraryMove(`${T}-3`, { run: { driveId: 'd1', under: 'A', pinned: true } }), true);
    assert.deepEqual(await db.libraryMoveRun(), { driveId: 'd1', under: 'A', pinned: true }, 'read as it is now, for GET');
    assert.equal(await db.updateLibraryMove(`${T}-3`, { until: 0, run: null }), true);
  });
});

describe('the library’s folders following its files, against a real database', { skip }, () => {
  const FROM = { tag: `${T}lib`, driveId: `${T}libd` };
  const TO = { tag: `${T}drv`, driveId: `${T}d1` };
  const namesIn = async (tag) => (await db.sql`SELECT name, parent, depth FROM folders WHERE filespace = ${tag} ORDER BY name`)
    .map((r) => [r.name, r.parent, r.depth]);

  /** Where moveFoldersIntoDrive is told each goes, as the route tells it: to `under`/its path, spelled as the drive spells it. */
  async function plan(from, to, under, { carry = null, held = [] } = {}) {
    const spellings = await db.folderSpellings({ tag: to.tag, prefix: to.tag });
    const destOf = (p) => landingPath(under, p, spellings);
    const state = await db.libraryFolderState({ from });
    return {
      tag: to.tag, driveId: to.driveId, under, createdBy: BOSS, from,
      folders: folderLandings(state.rows, destOf, { held: heldFolders(held) }),
      links: state.links.filter((l) => !carry || carry.includes(l.token)).map((l) => ({ token: l.token, dest: destOf(l.folder) })),
      stars: state.stars.map((folder) => ({ folder, dest: destOf(folder) })),
    };
  }

  test('folder rows with their tags, links and stars move in one statement; again, nothing changes', async () => {
    await db.setFolderMeta('Shoot', { tag: FROM.tag, tags: ['spring'], metadata: { client: 'Acme', season: 'Spring' } });
    await db.createFolder('Shoot/Day 1', { filespace: FROM.tag });
    await db.createFolder('Empty', { filespace: FROM.tag });
    await db.setFolderMeta('Old/Shoot', { tag: TO.tag, tags: ['team'], metadata: { client: 'Ours' } });
    const link = await db.createFolderShare({ folder: 'Shoot', storagePrefix: FROM.tag, createdBy: ED });
    await db.setFolderStar(ED, { driveId: FROM.driveId, folder: 'Shoot/Day 1', starred: true });
    await db.setFolderStar(BOSS, { driveId: FROM.driveId, folder: 'Shoot', starred: true });
    await db.setFolderStar(BOSS, { driveId: TO.driveId, folder: 'Old/Shoot', starred: true });

    const out = await db.moveFoldersIntoDrive(await plan(FROM, TO, 'Old'));
    assert.deepEqual(out, { folders: 3, copied: 0, links: 1, stars: 2 });
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

    const again = await db.moveFoldersIntoDrive(await plan(FROM, TO, 'Old'));
    assert.deepEqual(again, { folders: 0, copied: 0, links: 0, stars: 0 });
    assert.equal((await namesIn(TO.tag)).length, 4);
  });

  test('a name stored both composed and decomposed lands as one folder, where its files are; a link not carried stays', async () => {
    const from = { tag: `${T}lib3`, driveId: `${T}libd3` };
    const to = { tag: `${T}drv3`, driveId: `${T}d3` };
    const NFD = 'Cafe\u0301';
    const NFC = 'Caf\u00e9';
    await db.setFolderMeta(NFD, { tag: from.tag, tags: ['paris'], metadata: { city: 'Paris' } });
    await db.setFolderMeta(NFC, { tag: from.tag, tags: ['lyon'], metadata: { city: 'Lyon', country: 'FR' } });
    // Its files landed composed, as the route lands them.
    await file(`${to.tag}/${NFC}/a.jpg`, { folder: NFC });
    const kept = await db.createFolderShare({ folder: NFD, storagePrefix: from.tag, createdBy: ED });
    await db.setFolderStar(ED, { driveId: from.driveId, folder: NFD, starred: true });
    await db.setFolderStar(ED, { driveId: from.driveId, folder: NFC, starred: true });

    const out = await db.moveFoldersIntoDrive(await plan(from, to, '', { carry: [] }));
    assert.deepEqual(out, { folders: 2, copied: 0, links: 0, stars: 2 });
    assert.deepEqual(await namesIn(to.tag), [[NFC, '', 1]]);
    assert.deepEqual(await namesIn(from.tag), []);
    const meta = await db.listFolderMeta(to.tag);
    assert.deepEqual(meta.get(NFC), { tags: ['paris', 'lyon'], metadata: { city: 'Paris', country: 'FR' } });
    assert.deepEqual((await db.getShareRow(kept.token)).storage_prefix, from.tag, 'a link not carried is left where it was');
    assert.deepEqual((await db.listFolderStars(ED)).filter((s) => s.driveId === to.driveId).map((s) => s.folder), [NFC], 'two stars on one folder are one');
  });

  test('a folder still holding a file outside every drive is copied, and the library keeps it until the last has gone', async () => {
    const from = { tag: `${T}lib4`, driveId: `${T}libd4` };
    const to = { tag: `${T}drv4`, driveId: `${T}d4` };
    await db.setFolderMeta('Shoot', { tag: from.tag, tags: ['spring'], metadata: { client: 'Acme' } });
    await db.createFolder('Shoot/Day 1', { filespace: from.tag });
    await db.setFolderMeta('Done', { tag: from.tag, tags: ['done'] });
    await db.setFolderMeta('Theirs', { tag: from.tag, tags: ['lib'] });
    await db.setFolderMeta('Theirs', { tag: to.tag, tags: ['drive'], metadata: { client: 'Ours' } });

    // A private file stays in "Shoot/Day 1" (and so in "Shoot"), and one in "Theirs".
    const first = await db.moveFoldersIntoDrive(await plan(from, to, '', { held: ['Shoot/Day 1', 'Theirs'] }));
    assert.deepEqual(first, { folders: 1, copied: 3, links: 0, stars: 0 });
    assert.deepEqual((await namesIn(from.tag)).map((r) => r[0]), ['Shoot', 'Shoot/Day 1', 'Theirs'], 'kept for the files still there');
    assert.deepEqual((await namesIn(to.tag)).map((r) => r[0]), ['Done', 'Shoot', 'Shoot/Day 1', 'Theirs']);
    const fromMeta = await db.listFolderMeta(from.tag);
    const toMeta = await db.listFolderMeta(to.tag);
    assert.deepEqual(fromMeta.get('Shoot'), { tags: ['spring'], metadata: { client: 'Acme' } }, 'the library’s as it was');
    assert.deepEqual(toMeta.get('Shoot'), { tags: ['spring'], metadata: { client: 'Acme' } }, 'and the drive’s the same');
    assert.deepEqual(toMeta.get('Theirs'), { tags: ['drive', 'lib'], metadata: { client: 'Ours' } }, 'merged where the drive had one');

    // The last of them moved: what the library kept follows, into the drive's rows.
    const last = await db.moveFoldersIntoDrive(await plan(from, to, ''));
    assert.deepEqual(last, { folders: 3, copied: 0, links: 0, stars: 0 });
    assert.deepEqual(await namesIn(from.tag), []);
    assert.deepEqual((await namesIn(to.tag)).map((r) => r[0]), ['Done', 'Shoot', 'Shoot/Day 1', 'Theirs']);
  });

  test('to the top of the drive, and a collection moved under a name of its own', async () => {
    const from = { tag: `${T}lib2`, driveId: `${T}libd2` };
    await db.createFolder('A/B', { filespace: from.tag });
    const out = await db.moveFoldersIntoDrive(await plan(from, { tag: `${T}drv2`, driveId: `${T}d2` }, ''));
    assert.equal(out.folders, 2);
    assert.deepEqual((await namesIn(`${T}drv2`)).map((r) => r[0]), ['A', 'A/B']);

    const c = await db.createCollection({ name: 'Selects', driveId: from.driveId, rules: [{ field: 'kind', op: 'any', values: ['image'] }] });
    const moved = await db.moveCollection(c.id, { driveId: `${T}d2`, name: 'Selects (2)' });
    assert.deepEqual([moved.driveId, moved.name, moved.rules], [`${T}d2`, 'Selects (2)', c.rules]);
  });
});
