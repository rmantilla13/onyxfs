// Folder names per scope, against a real database: the SQL behind the
// folder routes (lib/db.js). A folder row is a name within a scope — a
// drive's prefix, or '' for the library — so each scope creates, finds,
// renames and deletes only its own, and folder grants, which are keyed by
// the path alone, only follow a rename or go with a delete as far as that
// stays inside the scope. Runs with TEST_DATABASE_URL pointing at a
// throwaway database, and skips without one, like the other database tests.
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
process.env.ADMIN_EMAILS = 'boss@fs.test';
process.env.SCHEMA_MANAGED = '0';
const skip = !live && 'TEST_DATABASE_URL not reachable';

const db = await import('../lib/db.js');

const T = `fs${Math.random().toString(36).slice(2, 8)}`;
const A = `a-${T}`; // one drive's prefix, as folders.filespace holds it
const B = `b-${T}`; // another drive's
const n = (name) => `${name} ${T}`;
const made = [];

before(async () => {
  if (!live) return;
  await db.ensureSchema();
});

after(async () => {
  if (live) {
    for (const id of made) await db.sql`DELETE FROM files WHERE id = ${id}`.catch(() => {});
    await db.sql`DELETE FROM folders WHERE name LIKE ${`%${T}%`}`.catch(() => {});
    await db.sql`DELETE FROM folder_access WHERE folder LIKE ${`%${T}%`}`.catch(() => {});
  }
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

const rows = async (name) => (await db.sql`
  SELECT COALESCE(filespace, '') AS tag, name FROM folders WHERE name = ${name} OR name LIKE ${`${name}/%`} ORDER BY 1, 2`)
  .map((r) => `${r.tag || 'library'}:${r.name}`);
const grants = async (name) => (await db.sql`SELECT folder FROM folder_access WHERE folder = ${name} ORDER BY folder`).map((r) => r.folder);
async function file(folder, key) {
  const f = await db.createFile({ name: 'f.txt', url: `http://s3.test/b/${key}`, size: 1, folder, storage: 's3', storageKey: key, createdBy: 'x@fs.test' });
  made.push(f.id);
  return f;
}

describe('folder names per scope, against a real database', { skip }, () => {
  test('the identity is (scope, name), and rows from before need nothing', async () => {
    const [idx] = await db.sql`SELECT indexdef FROM pg_indexes WHERE tablename = 'folders' AND indexname = 'folders_scope_name_idx'`;
    assert.match(idx.indexdef, /^CREATE UNIQUE INDEX folders_scope_name_idx ON public\.folders USING btree \(COALESCE\(filespace, ''::text\), name\)$/);
    // A row written before the column had a value: NULL is the library's.
    await db.sql`INSERT INTO folders (name, created_at, filespace) VALUES (${n('Legacy')}, ${Date.now()}, NULL)`;
    assert.deepEqual(await db.createFolder(n('Legacy'), { filespace: '' }), { name: n('Legacy'), created: false, existed: true });
    assert.ok((await db.listSyncFolders({ isAdmin: true }, {})).includes(n('Legacy')), 'listed as the library’s');
    assert.equal(await db.folderPathInUse(n('Legacy')), true);
    assert.deepEqual(await db.createFolder(n('Legacy'), { filespace: A }), { name: n('Legacy'), created: true, existed: false });
    // The rule the index keeps: one row per name within a scope.
    await assert.rejects(db.sql`INSERT INTO folders (name, created_at, filespace) VALUES (${n('Legacy')}, ${Date.now()}, '')`, /duplicate key/);
    await assert.rejects(db.sql`INSERT INTO folders (name, created_at, filespace) VALUES (${n('Legacy')}, ${Date.now()}, ${A})`, /duplicate key/);
  });

  test('create: once per scope, ancestors with it', async () => {
    const cam = `${n('Day 1')}/Cam A`;
    assert.deepEqual(await db.createFolder(cam, { filespace: A }), { name: cam, created: true, existed: false });
    assert.deepEqual(await db.createFolder(cam, { filespace: A }), { name: cam, created: false, existed: true });
    assert.deepEqual(await rows(n('Day 1')), [`${A}:${n('Day 1')}`, `${A}:${n('Day 1')}/Cam A`]);
    const [r] = await db.sql`SELECT parent, depth FROM folders WHERE name = ${`${n('Day 1')}/Cam A`}`;
    assert.deepEqual([r.parent, r.depth], [n('Day 1'), 2]);
  });

  test('the old primary key on the name alone is gone, and the name stays NOT NULL', async () => {
    const [pk] = await db.sql`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'folders_pkey'`;
    assert.equal(pk.n, 0);
    const [col] = await db.sql`SELECT attnotnull FROM pg_attribute WHERE attrelid = 'folders'::regclass AND attname = 'name'`;
    assert.equal(col.attnotnull, true);
  });

  test('two drives and the library each have "Selects": create, rename, delete and list, each its own', async () => {
    for (const tag of [A, B, '']) {
      assert.deepEqual(await db.createFolder(`${n('Selects')}/Empty`, { filespace: tag }), { name: `${n('Selects')}/Empty`, created: true, existed: false });
    }
    assert.deepEqual(await rows(n('Selects')), [
      `library:${n('Selects')}`, `library:${n('Selects')}/Empty`,
      `${A}:${n('Selects')}`, `${A}:${n('Selects')}/Empty`, `${B}:${n('Selects')}`, `${B}:${n('Selects')}/Empty`,
    ]);
    // Rename in one drive: the other drive's and the library's stay. (The
    // UPDATE used to match rows by name alone, and would have renamed all
    // three.)
    const out = await db.renameFolder(n('Selects'), n('Picks'), { tag: A });
    assert.equal(out.folders, 2);
    assert.deepEqual(await rows(n('Picks')), [`${A}:${n('Picks')}`, `${A}:${n('Picks')}/Empty`]);
    assert.deepEqual(await rows(n('Selects')), [
      `library:${n('Selects')}`, `library:${n('Selects')}/Empty`, `${B}:${n('Selects')}`, `${B}:${n('Selects')}/Empty`,
    ]);
    // Move onto a name the other drive has: this drive's own is free.
    await db.renameFolder(n('Picks'), n('Selects'), { tag: A });
    assert.equal((await rows(n('Selects'))).length, 6);
    // Delete in the other drive: this one's and the library's stay.
    await db.deleteFolderRows(n('Selects'), { tag: B });
    assert.deepEqual(await rows(n('Selects')), [
      `library:${n('Selects')}`, `library:${n('Selects')}/Empty`, `${A}:${n('Selects')}`, `${A}:${n('Selects')}/Empty`,
    ]);
    // In use, and the sync feed's folders, each for its own scope.
    assert.equal(await db.folderPathInUse(n('Selects'), { tag: B, prefix: B }), false);
    assert.equal(await db.folderPathInUse(n('Selects'), { tag: A, prefix: A }), true);
    const inA = await db.listSyncFolders({ email: 'm@fs.test' }, { storagePrefix: A });
    const inB = await db.listSyncFolders({ email: 'm@fs.test' }, { storagePrefix: B });
    assert.ok(inA.includes(n('Selects')) && inA.includes(`${n('Selects')}/Empty`));
    assert.ok(!inB.includes(n('Selects')));
    // And the same name twice in one scope is still one folder.
    assert.deepEqual(await db.createFolder(n('Selects'), { filespace: A }), { name: n('Selects'), created: false, existed: true });
  });

  test('in use: each scope as its own view shows it', async () => {
    await db.createFolder(`${n('X')}/Sub`, { filespace: A });
    await file(n('F'), `${A}/${n('F')}/f.txt`);
    assert.equal(await db.folderPathInUse(n('X'), { tag: A, prefix: A }), true);
    assert.equal(await db.folderPathInUse(n('X'), { tag: B, prefix: B }), false, 'another drive’s folder is no obstacle');
    assert.equal(await db.folderPathInUse(n('X')), false, 'nor for the library');
    assert.equal(await db.folderPathInUse(n('F'), { tag: A, prefix: A }), true, 'a file under the drive’s prefix');
    assert.equal(await db.folderPathInUse(n('F'), { tag: B, prefix: B }), false);
    assert.equal(await db.folderPathInUse(n('F')), true, 'the library’s view lists every file');
    assert.deepEqual(await db.listFolderRowsUnder(n('X'), { tag: A }), [`${n('X')}/Sub`]);
    assert.deepEqual(await db.listFolderRowsUnder(n('X'), { tag: B }), []);
    assert.deepEqual(await db.listFolderRowsUnder(n('X')), []);
  });

  test('rename and delete touch this scope’s rows alone', async () => {
    await db.createFolder(`${n('R')}/Sub`, { filespace: A });
    await db.createFolder(n('Q'), { filespace: '' });
    const out = await db.renameFolder(n('R'), n('R2'), { tag: A });
    assert.equal(out.folders, 2);
    assert.deepEqual(await rows(n('R2')), [`${A}:${n('R2')}`, `${A}:${n('R2')}/Sub`]);
    assert.deepEqual(await db.deleteFolderRows(n('R2'), { tag: B }), { ok: true, remaining: 0 });
    assert.equal((await rows(n('R2'))).length, 2, 'another scope’s delete leaves them');
    await db.deleteFolderRows(n('R2'), { tag: A });
    assert.deepEqual(await rows(n('R2')), []);
    assert.deepEqual(await rows(n('Q')), [`library:${n('Q')}`]);
    // A path only the library has a row at is, to the drive, a folder of its
    // own with nothing in it yet: renamed, the drive has the new one, and
    // the library still has its own.
    await db.renameFolder(n('Q'), n('Q2'), { tag: A });
    assert.deepEqual([await rows(n('Q')), await rows(n('Q2'))], [[`library:${n('Q')}`], [`${A}:${n('Q2')}`]]);
  });

  test('the sync feed’s folders are the scope’s own', async () => {
    await db.createFolder(n('Only A'), { filespace: A });
    await db.createFolder(n('Only Library'), { filespace: '' });
    const inA = await db.listSyncFolders({ email: 'm@fs.test' }, { storagePrefix: A });
    assert.ok(inA.includes(n('Only A')) && !inA.includes(n('Only Library')));
    const lib = await db.listSyncFolders({ isAdmin: true }, {});
    assert.ok(lib.includes(n('Only Library')) && !lib.includes(n('Only A')));
    assert.ok(!(await db.listSyncFolders({ email: 'm@fs.test' }, { storagePrefix: B })).includes(n('Only A')));
  });

  test('grants follow a drive’s rename only from a path that is the drive’s alone, and never onto another’s', async () => {
    // The drive's alone: moved.
    await db.createFolder(n('H'), { filespace: A });
    await db.grantFolderAccess({ folder: n('H'), subjectType: 'user', subject: 'carol@fs.test', role: 'viewer', grantedBy: 'boss@fs.test' });
    await db.renameFolder(n('H'), n('H2'), { tag: A });
    assert.deepEqual([await grants(n('H')), await grants(n('H2'))], [[], [n('H2')]]);

    // A path the library also has: the grant is not the drive's to take along.
    await db.createFolder(n('G'), { filespace: '' });
    await db.grantFolderAccess({ folder: n('G'), subjectType: 'user', subject: 'bob@fs.test', role: 'owner', grantedBy: 'boss@fs.test' });
    assert.equal(await db.renameSpreadsGrants(n('G'), n('G2'), { tag: A }), false, 'nothing of the drive’s to refuse over');
    await db.renameFolder(n('G'), n('G2'), { tag: A });
    assert.deepEqual([await grants(n('G')), await grants(n('G2'))], [[n('G')], []]);
    // Files of another scope left at the old path hold it the same way.
    await file(n('P'), `${B}/${n('P')}/f.txt`);
    await db.grantFolderAccess({ folder: n('P'), subjectType: 'user', subject: 'bob@fs.test', role: 'viewer', grantedBy: 'boss@fs.test' });
    await db.renameFolder(n('P'), n('P2'), { tag: A, moveGrants: false });
    assert.deepEqual([await grants(n('P')), await grants(n('P2'))], [[n('P')], []]);

    // Onto a name another scope uses: refused up front, and never copied.
    await db.createFolder(n('J'), { filespace: A });
    await db.grantFolderAccess({ folder: n('J'), subjectType: 'user', subject: 'carol@fs.test', role: 'viewer', grantedBy: 'boss@fs.test' });
    await db.createFolder(n('K'), { filespace: '' });
    assert.equal(await db.renameSpreadsGrants(n('J'), n('K'), { tag: A }), true);
    assert.equal(await db.renameSpreadsGrants(n('J'), n('K2'), { tag: A }), false);
    assert.equal(await db.renameSpreadsGrants(n('J'), n('K'), { tag: A, outside: 1 }), false, 'shared at the old path: they stay anyway');
    // Past the refusal (a race), the statement itself still copies nothing to
    // a path another scope uses — here, by a file of another drive's there.
    await file(n('K2'), `${B}/${n('K2')}/f.txt`);
    await db.renameFolder(n('J'), n('K2'), { tag: A });
    assert.deepEqual([await grants(n('J')), await grants(n('K2'))], [[n('J')], []]);

    // The library, whose folders take a grant to restructure: copied, as before.
    await db.createFolder(n('L'), { filespace: '' });
    await db.grantFolderAccess({ folder: n('L'), subjectType: 'role', subject: 'member', role: 'viewer', grantedBy: 'boss@fs.test' });
    await db.renameFolder(n('L'), n('L2'), { moveGrants: false });
    assert.deepEqual([await grants(n('L')), await grants(n('L2'))], [[n('L')], [n('L2')]]);
  });

  test('a delete keeps the grants while another scope still has the path', async () => {
    await db.createFolder(n('D'), { filespace: '' });
    await db.grantFolderAccess({ folder: n('D'), subjectType: 'user', subject: 'bob@fs.test', role: 'owner', grantedBy: 'boss@fs.test' });
    await db.deleteFolderRows(n('D'), { tag: A });
    assert.deepEqual(await grants(n('D')), [n('D')], 'the library still has it');
    await db.deleteFolderRows(n('D'));
    assert.deepEqual(await grants(n('D')), [], 'gone with the last of it');
  });
});
