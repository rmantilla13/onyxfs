// What a synced disk shows against what the web shows, against a real
// Postgres: a drive's empty folders reach every member on both, a drive the
// caller may not open is refused rather than answered with the library, and
// a drive's folder rows follow it when it moves or goes.
//
// Runs only with TEST_DATABASE_URL (a database you can write to), and skips
// cleanly without one. Every row it makes is tagged with a random suffix and
// removed at the end.

import { test, describe, before, after } from 'node:test';
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
const describeDb = live ? describe : describe.skip;

const T = `s${Math.random().toString(36).slice(2, 8)}`;
const at = (name) => `${name}.${T}@example.com`;
const ADMIN = at('admin');

describeDb('sync scope (database)', () => {
  let db, authz, listing;
  const made = { emails: new Set(), filespaces: [], prefixes: [] };

  before(async () => {
    process.env.DATABASE_URL = URL_;
    process.env.ADMIN_EMAILS = ADMIN;
    process.env.SCHEMA_MANAGED = '0';
    db = await import('../lib/db.js');
    const results = await db.ensureSchema();
    assert.deepEqual(results.filter((r) => !r.ok), [], 'every guard runs on this database');
    authz = await import('../lib/authz.js');
    listing = await import('../lib/file-listing.js');
  });

  after(async () => {
    if (!db) return;
    for (const e of made.emails) await db.removePerson(e, { apply: true }).catch(() => {});
    for (const id of made.filespaces) await db.deleteFilespace(id).catch(() => {});
    for (const p of made.prefixes) await db.sql`DELETE FROM folders WHERE filespace = ${p} OR name LIKE ${`%${T}%`}`.catch(() => {});
    await db.sql.end({ timeout: 5 }).catch(() => {});
  });

  const approved = async (name) => {
    const e = at(name);
    made.emails.add(e);
    await db.adminAddApprovedInvite({ email: e, reviewedBy: ADMIN });
    await db.upsertPerson(e, { roleId: 'member' });
    return e;
  };
  const rowsIn = async (tag) => (await db.sql`SELECT name FROM folders WHERE COALESCE(filespace, '') = ${tag} ORDER BY name`).map((r) => r.name);
  const drive = async (name) => {
    const prefix = `${name.toLowerCase()}-${T}`;
    const fs = await db.createFilespace({ name: `${name} ${T}`, bucket: 'b', prefix, createdBy: ADMIN });
    made.filespaces.push(fs.id);
    made.prefixes.push(prefix);
    return fs;
  };

  test("a drive's empty folder is in every member's web tree, as on their disk", async () => {
    const fs = await drive('Brand');
    const editor = await approved('editor');
    const viewer = await approved('viewer');
    await db.grantFilespaceAccess({ filespaceId: fs.id, email: editor, role: 'editor', grantedBy: ADMIN });
    await db.grantFilespaceAccess({ filespaceId: fs.id, email: viewer, role: 'viewer', grantedBy: ADMIN });
    const empty = `Empty ${T}/Inner`;
    await db.createFolder(empty, { createdBy: editor, filespace: fs.prefix });

    for (const who of [editor, viewer]) {
      const p = await authz.getPrincipal(who);
      const prefix = await listing.storagePrefixFor(who, fs.id, p);
      assert.equal(prefix, fs.prefix);
      const web = (await listing.listFolderTree({ principal: p, storagePrefix: prefix })).map((f) => f.folder);
      const disk = await db.listSyncFolders(p, { storagePrefix: prefix });
      assert.ok(disk.includes(empty), 'the disk has it');
      assert.ok(web.includes(empty) && web.includes(`Empty ${T}`), `${who}'s web tree has it and its parent`);
    }
  });

  test('a drive the caller may not open is refused, not answered with the library', async () => {
    const fs = await drive('Clients');
    const outsider = await approved('outsider');
    const p = await authz.getPrincipal(outsider);
    assert.equal(await listing.storagePrefixFor(outsider, fs.id, p), null, 'not theirs');
    assert.equal(await listing.storagePrefixFor(outsider, `nope-${T}`, p), null, 'not there');
    assert.equal(await listing.storagePrefixFor(outsider, '', p), undefined, 'no drive asked for: the library');
  });

  test("a drive's folder rows follow its prefix, and fall to the library when it goes", async () => {
    const fs = await drive('Moving');
    await db.createFolder(`Keep ${T}`, { createdBy: ADMIN, filespace: fs.prefix });
    await db.createFolder(`Clash ${T}`, { createdBy: ADMIN, filespace: fs.prefix });
    const next = `moved-${T}`;
    made.prefixes.push(next);
    await db.createFolder(`Clash ${T}`, { createdBy: ADMIN, filespace: next });
    await db.updateFilespace(fs.id, { prefix: next });
    assert.deepEqual(await rowsIn(fs.prefix), [], 'nothing left under the old prefix');
    assert.deepEqual((await rowsIn(next)).filter((n) => n.includes(T)).sort(), [`Clash ${T}`, `Keep ${T}`]);

    await db.deleteFilespace(fs.id);
    made.filespaces.splice(made.filespaces.indexOf(fs.id), 1);
    assert.deepEqual(await rowsIn(next), [], 'nothing tagged for a drive that is gone');
    const lib = await db.sql`SELECT name FROM folders WHERE COALESCE(filespace, '') = '' AND name LIKE ${`%${T}`}`;
    assert.deepEqual(lib.map((r) => r.name).sort(), [`Clash ${T}`, `Keep ${T}`], 'its empty folders are the library’s now, like its files');
  });
});
