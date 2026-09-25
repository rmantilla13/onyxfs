// Folder rename / move / delete in the catalog. Runs only with
// TEST_DATABASE_URL pointing at a throwaway database.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

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
const skip = !live && 'TEST_DATABASE_URL not reachable';

const T = `t${Date.now().toString(36)}`; // a root no other test touches

async function file(folder, key, storage = 's3') {
  return db.createFile({
    name: key ? key.slice(key.lastIndexOf('/') + 1) : 'b.txt', url: `http://s3.test/b/${key || 'blob'}`,
    mime: 'text/plain', size: 1, folder, storage, storageKey: key, createdBy: 'test@example.com',
  });
}

after(async () => {
  if (live) {
    await db.sql`DELETE FROM files WHERE folder LIKE ${T + '%'}`.catch(() => {});
    await db.sql`DELETE FROM folders WHERE name LIKE ${T + '%'}`.catch(() => {});
    await db.sql`DELETE FROM folder_access WHERE folder LIKE ${T + '%'}`.catch(() => {});
  }
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

test('folders: rename moves files, rows and grants in one go', { skip }, async () => {

  const a = await file(`${T}/Clients`, `files/${T}/Clients/a.pdf`);
  const b = await file(`${T}/Clients/Acme`, `files/${T}/Clients/Acme/b.png`);
  const blob = await file(`${T}/Clients`, null, 'blob');
  // A sibling whose name only shares a prefix, and one with a LIKE wildcard
  // in the way: neither is inside `Clients`.
  const sib = await file(`${T}/Clients2`, `files/${T}/Clients2/c.png`);
  const wild = await file(`${T}/ClientsX`, `files/${T}/ClientsX/d.png`);
  await db.createFolder(`${T}/Clients/Empty`, {});
  await db.grantFolderAccess({ folder: `${T}/Clients`, subjectType: 'user', subject: 'ed@example.com', role: 'editor' });

  const sub = await db.listFolderSubtreeFiles(`${T}/Clients`);
  assert.deepEqual(sub.map((f) => f.id).sort(), [a.id, b.id, blob.id].sort());
  // `_` in a name is a LIKE wildcard; a folder called "Client_" must not
  // take in "ClientsX".
  assert.deepEqual(await db.listFolderSubtreeFiles(`${T}/Client_`), []);
  assert.equal(await db.folderPathInUse(`${T}/Clients/Empty`), true);
  assert.equal(await db.folderPathInUse(`${T}/Nope`), false);

  const before = await db.getFileById(a.id);
  const res = await db.renameFolder(`${T}/Clients`, `${T}/Archive/Customers`, {
    moves: [
      { id: a.id, folder: `${T}/Archive/Customers`, toKey: `files/${T}/Archive/Customers/a.pdf` },
      { id: b.id, folder: `${T}/Archive/Customers/Acme`, toKey: `files/${T}/Archive/Customers/Acme/b.png` },
    ],
    catalog: [{ id: blob.id, folder: `${T}/Archive/Customers` }],
  });
  assert.equal(res.files, 3);

  const after = await db.getFileById(a.id);
  assert.equal(after.folder, `${T}/Archive/Customers`);
  assert.equal(after.storageKey, `files/${T}/Archive/Customers/a.pdf`);
  assert.ok(Number(after.seq) > Number(before.seq), 'sync clients hear about the move');
  assert.equal((await db.getFileById(b.id)).folder, `${T}/Archive/Customers/Acme`);
  assert.equal((await db.getFileById(blob.id)).storageKey, null);
  assert.equal((await db.getFileById(sib.id)).folder, `${T}/Clients2`);
  assert.equal((await db.getFileById(wild.id)).folder, `${T}/ClientsX`);

  const rows = (await db.sql`SELECT name, parent, depth FROM folders WHERE name LIKE ${T + '/%'} ORDER BY name`);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.ok(byName[`${T}/Archive/Customers/Empty`], 'the empty subfolder moved');
  assert.equal(byName[`${T}/Archive/Customers/Empty`].parent, `${T}/Archive/Customers`);
  assert.equal(byName[`${T}/Archive/Customers/Empty`].depth, 4);
  assert.ok(byName[`${T}/Archive`], 'the new parent exists as a folder');
  assert.ok(!byName[`${T}/Clients/Empty`]);

  const grants = await db.sql`SELECT folder FROM folder_access WHERE subject = 'ed@example.com' AND folder LIKE ${T + '%'}`;
  assert.deepEqual(grants.map((g) => g.folder), [`${T}/Archive/Customers`]);
});

test('folders: a rename that cannot commit changes nothing', { skip }, async () => {
  const x = await file(`${T}/Keep`, `files/${T}/Keep/x.txt`);
  // Landing on a row that already exists breaks the primary key, so the one
  // statement fails and the file stays where it was.
  await db.createFolder(`${T}/Keep/Sub`, {});
  await db.createFolder(`${T}/Taken/Sub`, {});
  await assert.rejects(db.renameFolder(`${T}/Keep`, `${T}/Taken`, {
    moves: [{ id: x.id, folder: `${T}/Taken`, toKey: `files/${T}/Taken/x.txt` }],
  }));
  const still = await db.getFileById(x.id);
  assert.equal(still.folder, `${T}/Keep`);
  assert.equal(still.storageKey, `files/${T}/Keep/x.txt`);
  const [row] = await db.sql`SELECT count(*)::int AS n FROM folders WHERE name = ${`${T}/Keep/Sub`}`;
  assert.equal(row.n, 1);
});

test('folders: grants are copied, not moved, when another scope keeps files at the old path', { skip }, async () => {
  await file(`${T}/Shared`, `files/${T}/Shared/s.txt`);
  await db.grantFolderAccess({ folder: `${T}/Shared`, subjectType: 'role', subject: 'member', role: 'viewer' });
  await db.renameFolder(`${T}/Shared`, `${T}/Shared2`, { moves: [], catalog: [], moveGrants: false });
  const g = await db.sql`SELECT folder FROM folder_access WHERE subject = 'member' AND folder LIKE ${T + '/Shared%'} ORDER BY folder`;
  assert.deepEqual(g.map((r) => r.folder), [`${T}/Shared`, `${T}/Shared2`]);
});

test('folders: deleting rows keeps grants while live files remain', { skip }, async () => {
  const f = await file(`${T}/Gone/a`, `files/${T}/Gone/a/f.txt`);
  await db.createFolder(`${T}/Gone/a/empty`, {});
  await db.grantFolderAccess({ folder: `${T}/Gone`, subjectType: 'user', subject: 'o@example.com', role: 'owner' });
  let r = await db.deleteFolderRows(`${T}/Gone`);
  assert.equal(r.remaining, 1);
  assert.equal((await db.sql`SELECT count(*)::int AS n FROM folder_access WHERE folder = ${`${T}/Gone`}`)[0].n, 1);
  assert.equal((await db.sql`SELECT count(*)::int AS n FROM folders WHERE name LIKE ${`${T}/Gone%`}`)[0].n, 0);
  await db.softDeleteFile(f.id);
  r = await db.deleteFolderRows(`${T}/Gone`);
  assert.equal(r.remaining, 0);
  assert.equal((await db.sql`SELECT count(*)::int AS n FROM folder_access WHERE folder = ${`${T}/Gone`}`)[0].n, 0);
});
