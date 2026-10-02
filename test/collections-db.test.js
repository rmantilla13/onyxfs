// Collections against a real database: the predicate lib/file-query.js
// builds from a collection's rules, run by the listing (listFilesForUser),
// with tags and metadata inherited from folder rows in the file's own scope
// (setFolderMeta). Runs with TEST_DATABASE_URL pointing at a throwaway
// database, and skips without one, like the other database tests.

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
process.env.ADMIN_EMAILS = 'boss@col.test';
process.env.SCHEMA_MANAGED = '0';
const skip = !live && 'TEST_DATABASE_URL not reachable';

const db = await import('../lib/db.js');
const { drivePatterns } = await import('../lib/drive-access.js');
const { normalizeCollection } = await import('../lib/collections.js');

const T = `col${Math.random().toString(36).slice(2, 8)}`;
const DRIVE = `team-${T}`; // a drive's prefix, as folders.filespace holds it
const LIB = `files-${T}`; // where the library's files are kept
const made = [];
const admin = { email: 'boss@col.test', isAdmin: true };

before(async () => {
  if (!live) return;
  await db.ensureSchema();
});

after(async () => {
  if (live) {
    for (const id of made) await db.sql`DELETE FROM files WHERE id = ${id}`.catch(() => {});
    await db.sql`DELETE FROM folders WHERE name LIKE ${`%${T}%`}`.catch(() => {});
  }
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

async function file(name, folder, { drive = false, tags = [], metadata = {}, kind = 'image' } = {}) {
  const key = `${drive ? DRIVE : LIB}/${folder}/${name}`;
  const f = await db.createFile({
    name, url: `http://s3.test/b/${key}`, size: 1, folder, storage: 's3', storageKey: key,
    createdBy: 'x@col.test', tags, metadata, kind,
  });
  made.push(f.id);
  return f;
}

// The names, in this run's folders, that a collection lists.
async function names(rules, match = 'all') {
  const { files } = await db.listFilesForUser({
    folderPrefix: '', sort: 'name', limit: 500,
    collection: { ...normalizeCollection({ match, rules }), drivePatterns: drivePatterns([{ prefix: DRIVE }]) },
  }, admin);
  return files.filter((f) => f.folder.includes(T)).map((f) => f.name).sort();
}

describe('collections, against a real database', { skip }, () => {
  const top = `Shoots ${T}`;

  test('setup: files with tags and metadata, and tagged folders', async () => {
    await file('own-tag.jpg', `${top}/Loose`, { tags: ['hero'] });
    await file('in-spring.jpg', `${top}/Spring/Day 1`);
    await file('in-spring.mov', `${top}/Spring/Day 2`, { kind: 'video', metadata: { status: 'Archived' } });
    await file('elsewhere.jpg', `${top}/Summer`, { metadata: { project: ['Summer'] } });
    await file('drive-spring.jpg', `${top}/Spring`, { drive: true });
    await file('expiring.jpg', `${top}/Loose`, { metadata: { web_expiration: '2026-03-01' } });

    // The library's Spring folder carries a tag and a project; its files inherit both.
    const saved = await db.setFolderMeta(`${top}/Spring`, { tag: '', tags: ['Spring', 'spring', 'Launch'], metadata: { project: ['Spring'] } });
    assert.deepEqual(saved.tags, ['spring', 'launch'], 'lower case, once each');
    assert.deepEqual(saved.metadata, { project: ['Spring'] });
    const [row] = await db.sql`SELECT name FROM folders WHERE name = ${top} AND COALESCE(filespace, '') = ''`;
    assert.ok(row, 'a folder known only from its files gets its row, ancestors too');
  });

  test('a tag reaches every file beneath the folder that carries it', async () => {
    assert.deepEqual(await names([{ field: 'tag', op: 'any', values: ['spring'] }]), ['in-spring.jpg', 'in-spring.mov']);
  });

  test('a folder in the library does not reach a drive’s folder of the same path', async () => {
    assert.ok(!(await names([{ field: 'tag', op: 'any', values: ['spring'] }])).includes('drive-spring.jpg'));
    await db.setFolderMeta(`${top}/Spring`, { tag: DRIVE, tags: ['drive-only'] });
    assert.deepEqual(await names([{ field: 'tag', op: 'any', values: ['drive-only'] }]), ['drive-spring.jpg'], 'and the drive’s reaches only its own');
  });

  test('a file’s own tags count, and any-of is either', async () => {
    assert.deepEqual(await names([{ field: 'tag', op: 'any', values: ['hero', 'launch'] }]), ['in-spring.jpg', 'in-spring.mov', 'own-tag.jpg']);
  });

  test('metadata: own and inherited, list or single value, any case', async () => {
    assert.deepEqual(await names([{ field: 'meta:project', op: 'any', values: ['spring'] }]), ['in-spring.jpg', 'in-spring.mov']);
    assert.deepEqual(await names([{ field: 'meta:project', op: 'any', values: ['Summer'] }]), ['elsewhere.jpg']);
    assert.deepEqual(await names([{ field: 'meta:status', op: 'any', values: ['archived'] }]), ['in-spring.mov']);
  });

  test('the listing’s own tag filter matches too (it used to match nothing)', async () => {
    const { files } = await db.listFilesForUser({ folderPrefix: '', tags: ['hero'], limit: 500 }, admin);
    assert.deepEqual(files.filter((f) => f.folder.includes(T)).map((f) => f.name), ['own-tag.jpg']);
  });

  test('all narrows, any widens', async () => {
    const rules = [{ field: 'tag', op: 'any', values: ['spring'] }, { field: 'kind', op: 'any', values: ['video'] }];
    assert.deepEqual(await names(rules, 'all'), ['in-spring.mov']);
    assert.deepEqual(await names([{ field: 'tag', op: 'any', values: ['hero'] }, { field: 'kind', op: 'any', values: ['video'] }], 'any'), ['in-spring.mov', 'own-tag.jpg']);
  });

  test('none and not-set exclude what is inherited too', async () => {
    const none = await names([{ field: 'tag', op: 'none', values: ['spring'] }]);
    assert.ok(!none.includes('in-spring.jpg') && none.includes('elsewhere.jpg'));
    const unset = await names([{ field: 'meta:project', op: 'unset' }]);
    assert.deepEqual(unset, ['drive-spring.jpg', 'expiring.jpg', 'own-tag.jpg']);
  });

  test('dates compare by day', async () => {
    assert.deepEqual(await names([{ field: 'meta:web_expiration', op: 'before', values: ['2026-06-01'] }]), ['expiring.jpg']);
    assert.deepEqual(await names([{ field: 'meta:web_expiration', op: 'after', values: ['2026-06-01'] }]), []);
  });

  test('a folder’s tags follow it when it is renamed, and clearing them takes them away', async () => {
    await db.renameFolder(`${top}/Spring`, `${top}/Spring 26`, { tag: '', moves: [], catalog: [] });
    const [r] = await db.sql`SELECT tags FROM folders WHERE name = ${`${top}/Spring 26`} AND COALESCE(filespace, '') = ''`;
    assert.deepEqual(r.tags, ['spring', 'launch']);
    await db.setFolderMeta(`${top}/Spring 26`, { tag: '', tags: [], metadata: { project: null } });
    const meta = await db.listFolderMeta('');
    assert.equal(meta.has(`${top}/Spring 26`), false, 'nothing left on it');
  });

  test('collections are stored and read back', async () => {
    const c = await db.createCollection({ name: `Heroes ${T}`, driveId: '', match: 'any', rules: [{ field: 'tag', op: 'any', values: ['hero'] }] }, { createdBy: 'x@col.test' });
    assert.equal((await db.getCollection(c.id)).name, `Heroes ${T}`);
    const next = await db.updateCollection(c.id, { name: `Heroes 2 ${T}`, match: 'all', rules: c.rules });
    assert.equal(next.match, 'all');
    assert.equal(await db.deleteCollection(c.id), true);
    assert.equal(await db.getCollection(c.id), null);
  });
});
