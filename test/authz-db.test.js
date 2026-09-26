// The review fixes to the authorization core, against a real Postgres: a
// person's row born holding their v1 role, a degraded principal matching no
// role grant, drive roles reaching only the drive's own folders, a drive
// with no link kinds, issued upload keys, the ground a self-serve drive may
// not be laid over, and a drive's own key kept from its readers.
//
// Runs only with TEST_DATABASE_URL (a database you can write to), and skips
// cleanly without one, like the other database tests. Every row it makes is
// tagged with a random suffix and removed at the end.

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

const T = `z${Math.random().toString(36).slice(2, 8)}`;
const at = (name) => `${name}.${T}@example.com`;
const ADMIN = at('admin');

describeDb('the authorization fixes (database)', () => {
  let db, authz, roles, listing;
  const made = { emails: new Set(), filespaces: [], files: [], folders: [], settings: null };

  before(async () => {
    process.env.DATABASE_URL = URL_;
    process.env.ADMIN_EMAILS = ADMIN;
    process.env.SCHEMA_MANAGED = '0';
    db = await import('../lib/db.js');
    const results = await db.ensureSchema();
    assert.deepEqual(results.filter((r) => !r.ok), [], 'every guard runs on this database');
    authz = await import('../lib/authz.js');
    roles = await import('../lib/roles.js');
    listing = await import('../lib/file-listing.js');
    made.settings = await db.getSetting('roles.config', { fresh: true, strict: true });
  });

  after(async () => {
    if (!db) return;
    // Put roles.config back exactly as it was.
    if (made.settings == null) await db.deleteSetting('roles.config').catch(() => {});
    else await db.setSetting('roles.config', made.settings).catch(() => {});
    for (const e of made.emails) await db.removePerson(e, { apply: true }).catch(() => {});
    for (const id of made.files) await db.sql`DELETE FROM files WHERE id = ${id}`.catch(() => {});
    for (const id of made.filespaces) await db.deleteFilespace(id).catch(() => {});
    for (const f of made.folders) {
      await db.sql`DELETE FROM folders WHERE name = ${f} OR name LIKE ${`${f}/%`}`.catch(() => {});
      await db.sql`DELETE FROM folder_access WHERE folder = ${f} OR folder LIKE ${`${f}/%`}`.catch(() => {});
    }
    await db.sql`DELETE FROM upload_keys WHERE email LIKE ${`%.${T}@example.com`}`.catch(() => {});
    await db.sql.end({ timeout: 5 }).catch(() => {});
  });

  const approved = async (name) => {
    const e = at(name);
    made.emails.add(e);
    await db.adminAddApprovedInvite({ email: e, reviewedBy: ADMIN });
    return e;
  };

  // ── Roles: a row is born with its v1 assignment ──────────────────────────

  test('a new row takes its v1 assignment; after that the row alone decides', async () => {
    const viewer = await approved('v1-viewer');
    const mixed = await approved('v1-mixed');
    const plain = await approved('v1-plain');
    // Exactly the built-ins, plus assignments — a config that behaves as the
    // default for every other test sharing this database.
    await db.setSetting('roles.config', {
      version: 2, defaultRole: 'member', roles: roles.BUILTIN_ROLES,
      assignments: { [viewer]: 'viewer', [mixed.toUpperCase()]: 'contributor', [at('never')]: 42 },
    });

    const v = await db.upsertPerson(viewer, { seen: true });
    assert.equal(v.roleId, 'viewer', 'born holding the v1 role');
    assert.equal((await db.upsertPerson(mixed)).roleId, 'contributor', 'keys match as parseRolesConfig matches them');
    assert.equal((await db.upsertPerson(plain)).roleId, null, 'no assignment, the default');
    assert.equal((await db.upsertPerson(at('explicit'), { roleId: 'member' })).roleId, 'member', 'an explicit role wins');
    made.emails.add(at('explicit'));

    // An admin sets them back to the default: NULL, and it sticks — the v1
    // assignment is not read again for someone with a row.
    await db.updatePerson(viewer, { roleId: null });
    const p = await authz.getPrincipal(viewer);
    assert.equal(p.person.roleId, null);
    assert.equal(p.roleId, 'member');
    assert.equal(authz.can(p, 'files.upload').ok, true);
  });

  test('a v1 config stored double-encoded is read the same way', async () => {
    const e = await approved('v1-double');
    const cfg = { roles: [], assignments: { [e]: 'viewer' }, defaultRole: 'member' };
    await db.setSetting('roles.config', {});
    await db.sql`UPDATE settings SET value = to_jsonb(${JSON.stringify(cfg)}::text) WHERE key = 'roles.config'`;
    db.invalidateSetting('roles.config');
    assert.equal((await db.upsertPerson(e)).roleId, 'viewer');
  });

  // ── Degraded: no role-subject grant applies ──────────────────────────────

  test("a degraded principal does not see what is shared with the Viewer role", async () => {
    const member = await approved('degraded');
    await db.upsertPerson(member, { roleId: 'member' });
    const other = at('owner-of-private');
    const folder = `Client Review ${T}`;
    made.folders.push(folder);
    const file = await db.createFile({
      name: 'cut.mov', url: 'https://x/cut.mov', storage: 's3', storageKey: `files/${folder}/cut.mov`,
      folder, visibility: 'owner', createdBy: other,
    });
    made.files.push(file.id);
    await db.setFileAcl(file.id, { visibility: 'owner', roles: ['viewer'], grantedBy: ADMIN });
    const folderFile = await db.createFile({
      name: 'notes.pdf', url: 'https://x/notes.pdf', storage: 's3', storageKey: `files/${folder}/Sub/notes.pdf`,
      folder: `${folder}/Sub`, visibility: 'owner', createdBy: other,
    });
    made.files.push(folderFile.id);
    await db.grantFolderAccess({ folder: `${folder}/Sub`, subjectType: 'role', subject: 'viewer', role: 'viewer', grantedBy: ADMIN });

    const person = await db.getPersonByEmail(member);
    const grants = await db.loadDriveGrants(member);
    const rolesConfig = roles.parseRolesConfig(null);
    const build = async (degraded) => {
      const p = authz.principalFrom({ email: member, person, rolesConfig, globalFlags: null, grants, degraded });
      p.folderGrants = await db.folderGrantsFor(member, p.roleId);
      return p;
    };

    const normal = await build(false);
    assert.equal(await db.canAccessFile(file, normal), false, 'a Member is not the Viewer role');
    const degraded = await build(true);
    assert.equal(degraded.roleId, null);
    assert.equal(await db.canAccessFile(file, degraded), false, 'nor is a degraded Member');
    assert.equal(await db.canAccessFile(folderFile, degraded), false, 'no role folder grant either');
    const seen = await db.listFilesForUser({ folderPrefix: folder, limit: 50 }, degraded);
    assert.equal(seen.files.some((f) => f.id === file.id || f.id === folderFile.id), false, 'nor does the listing show them');

    // …and someone who really holds the Viewer role still does.
    const viewer = await approved('real-viewer');
    await db.upsertPerson(viewer, { roleId: 'viewer' });
    const vp = await authz.getPrincipal(viewer);
    assert.equal(await db.canAccessFile(file, vp), true);
  });

  // ── Folders: a drive role counts only for the drive's own ─────────────────

  test("a drive editor restructures the drive's folders, not the library's of the same name", async () => {
    const editor = await approved('folder-editor');
    await db.upsertPerson(editor, { roleId: 'member' });
    const tag = `mkt-${T}`;
    const board = `Board ${T}`;
    const plans = `Plans ${T}`;
    const mixed = `Mixed ${T}`;
    made.folders.push(board, plans, mixed);
    const bob = at('bob');
    await db.createFolder(board, { createdBy: ADMIN, filespace: '' });
    await db.grantFolderAccess({ folder: board, subjectType: 'user', subject: bob, role: 'owner', grantedBy: ADMIN });
    await db.createFolder(plans, { createdBy: editor, filespace: tag });
    await db.createFolder(mixed, { createdBy: editor, filespace: tag });
    await db.createFolder(`${mixed}/Legal`, { createdBy: ADMIN, filespace: '' });

    const p = await authz.getPrincipal(editor);
    const opts = { driveRole: 'editor', tag };
    assert.equal(await db.folderRoleFor(board, p, opts), null, "the library's folder is not the drive's");
    assert.equal(await db.canModifyFolder(board, p, opts), false);
    assert.equal(await db.folderRoleFor(plans, p, opts), 'editor', "the drive's own folder is");
    assert.equal(await db.folderRoleFor(`Nowhere ${T}/new`, p, opts), 'editor', 'a path nobody holds is the drive’s to use');
    assert.equal(await db.folderRoleFor(mixed, p, opts), null, 'a library folder beneath it makes it not only the drive’s');
    assert.equal(await db.folderRoleFor(plans, p, { driveRole: 'viewer', tag }), null, 'a drive viewer restructures nothing');
    assert.equal(await db.folderRoleFor(plans, p, { driveRole: 'editor' }), null, 'no drive named, no drive role');

    // A folder grant still counts, as it did before drive roles did.
    await db.grantFolderAccess({ folder: board, subjectType: 'user', subject: editor, role: 'editor', grantedBy: ADMIN });
    assert.equal(await db.folderRoleFor(board, p, opts), 'editor');
    // Bob's grant was never in reach.
    assert.equal((await db.listFolderGrants(board)).some((g) => g.subject === bob), true);
  });

  // ── Drives: no link kinds at all ─────────────────────────────────────────

  test("a drive's link kinds: [] is none, null is every kind, and both survive a save", async () => {
    const fs = await db.createFilespace({ name: `Kinds ${T}`, bucket: 'b', prefix: `kinds-${T}`, createdBy: ADMIN });
    made.filespaces.push(fs.id);
    await db.updateFilespace(fs.id, { shareKinds: [] });
    assert.deepEqual((await db.getFilespace(fs.id)).shareKinds, []);
    const member = await approved('kinds');
    await db.upsertPerson(member, { roleId: 'member' });
    await db.grantFilespaceAccess({ filespaceId: fs.id, email: member, role: 'editor' });
    const p = await authz.getPrincipal(member);
    const kinds = await authz.shareKindsForKey(p, `kinds-${T}/a.jpg`);
    assert.deepEqual(kinds, []);
    assert.equal(authz.can(p, 'shares.public', { canModify: true, kind: 'public', driveShareKinds: kinds }).ok, false);
    // Another setting saved later keeps it.
    await db.updateFilespace(fs.id, { quotaBytes: 10 });
    assert.deepEqual((await db.getFilespace(fs.id)).shareKinds, []);
    await db.updateFilespace(fs.id, { shareKinds: null });
    assert.equal((await db.getFilespace(fs.id)).shareKinds, null);
    await db.updateFilespace(fs.id, { shareKinds: ['private'] });
    assert.deepEqual((await db.getFilespace(fs.id)).shareKinds, ['private']);
  });

  // ── Uploads: only an issued key is recorded ──────────────────────────────

  test('an upload key is taken once, only by whom it was issued to, and only while fresh', async () => {
    const a = at('uploader');
    const b = at('someone-else');
    const key = `files/${T}/clip.mov`;
    await db.issueUploadKey(key, a, { bucket: 'b1' });
    assert.equal(await db.claimUploadKey(key, b), null, 'not theirs');
    assert.deepEqual(await db.claimUploadKey(key, a.toUpperCase()), { bucket: 'b1' });
    assert.equal(await db.claimUploadKey(key, a), null, 'and only once');
    assert.equal(await db.claimUploadKey(`files/${T}/never.mov`, a), null, 'never issued');

    const stale = `files/${T}/stale.mov`;
    await db.issueUploadKey(stale, a, { bucket: 'b1' });
    await db.sql`UPDATE upload_keys SET issued_at = ${Date.now() - db.UPLOAD_KEY_TTL_MS - 1000} WHERE storage_key = ${stale}`;
    assert.equal(await db.claimUploadKey(stale, a), null, 'expired');
    // Issuing again (multipart's complete) makes it fresh.
    await db.issueUploadKey(stale, a, { bucket: 'b1' });
    assert.ok(await db.claimUploadKey(stale, a));

    await db.issueUploadKey(`files/${T}/old.mov`, a);
    await db.sql`UPDATE upload_keys SET issued_at = 1 WHERE storage_key = ${`files/${T}/old.mov`}`;
    assert.ok((await db.pruneUploadKeys(Date.now() - db.UPLOAD_KEY_TTL_MS)) >= 1);
    assert.equal((await db.sql`SELECT 1 FROM upload_keys WHERE storage_key = ${`files/${T}/old.mov`}`).length, 0);
  });

  test("a key another row uses is in use, and a row sharing one is told so", async () => {
    const key = `files/${T}/shared.jpg`;
    const f = await db.createFile({ name: 'shared.jpg', url: 'https://x/s.jpg', storage: 's3', storageKey: key, createdBy: ADMIN });
    made.files.push(f.id);
    assert.equal(await db.storageKeyInUse(key), true);
    assert.equal(await db.storageKeyInUse(key, { exceptId: f.id }), false);
  });

  // ── Self-serve ground ────────────────────────────────────────────────────

  test('a prefix holding a file row, live or trashed, is not empty ground', async () => {
    const live = `left-${T}/live`;
    const trashed = `left-${T}/trashed`;
    assert.equal(await db.prefixHoldsFiles(live), false);
    const a = await db.createFile({ name: 'a.pdf', url: 'https://x/a', storage: 's3', storageKey: `${live}/a.pdf`, createdBy: ADMIN });
    const b = await db.createFile({ name: 'b.pdf', url: 'https://x/b', storage: 's3', storageKey: `${trashed}/b.pdf`, createdBy: ADMIN });
    made.files.push(a.id, b.id);
    await db.softDeleteFile(b.id, { trashKey: `_trash/${b.id}/${trashed}/b.pdf`, deletedBy: ADMIN });
    assert.equal(await db.prefixHoldsFiles(live), true);
    assert.equal(await db.prefixHoldsFiles(trashed), true, 'a restore would put it back there');
    assert.equal(await db.prefixHoldsFiles(`left-${T}/liv`), false, 'only at a folder boundary');
    assert.equal(await db.prefixHoldsFiles(`left_${T}`), false, 'LIKE characters are literal');
  });

  // ── Menus: what the listing says may be done ─────────────────────────────

  test('the listing marks what may be done to each file, grants included', async () => {
    const member = await approved('menus');
    await db.upsertPerson(member, { roleId: 'member' });
    const folder = `Shared ${T}`;
    made.folders.push(folder);
    const mine = await db.createFile({ name: 'm.jpg', url: 'https://x/m', storage: 's3', storageKey: `files/${folder}/m.jpg`, folder, createdBy: member });
    const theirs = await db.createFile({ name: 't.jpg', url: 'https://x/t', storage: 's3', storageKey: `files/${folder}/t.jpg`, folder, createdBy: at('colleague') });
    made.files.push(mine.id, theirs.id);
    const p = await authz.getPrincipal(member);
    let [a, b] = await listing.withFileCan([mine, theirs], p);
    assert.deepEqual(a.can, { edit: true, delete: true, share: true });
    assert.deepEqual(b.can, { edit: false, delete: false, share: false });
    // An editor grant on the folder makes the colleague's file theirs to change.
    await db.grantFolderAccess({ folder, subjectType: 'user', subject: member, role: 'editor', grantedBy: ADMIN });
    [a, b] = await listing.withFileCan([mine, theirs], p);
    assert.deepEqual(b.can, { edit: true, delete: true, share: true });
  });

  // ── STS: a drive's own key is kept from its readers ──────────────────────

  test("a drive's own key goes to its writers, never to someone who may only read", async () => {
    const route = await import('../app/api/space/sts/route.js');
    const fs = await db.createFilespace({
      name: `Own key ${T}`, bucket: 'own-bucket', prefix: `own-${T}`, createdBy: ADMIN,
      accessKeyId: 'AKOWNKEY', secretAccessKey: 'SKOWNSECRET', endpoint: 'https://r2.example.com',
    });
    made.filespaces.push(fs.id);
    const call = async (email) => {
      const token = await db.createDesktopToken({ email });
      const res = await route.POST(new Request('http://localhost/api/space/sts', {
        method: 'POST', headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ filespaceId: fs.id }),
      }));
      return { status: res.status, body: await res.json() };
    };

    // A platform Viewer granted editor: capped at viewer, refused the key.
    const viewer = await approved('own-viewer');
    await db.upsertPerson(viewer, { roleId: 'viewer' });
    await db.grantFilespaceAccess({ filespaceId: fs.id, email: viewer, role: 'editor' });
    const v = await call(viewer);
    assert.equal(v.status, 403);
    assert.equal(v.body.readOnly, true);
    assert.equal(v.body.accessKeyId, undefined);
    assert.equal(JSON.stringify(v.body).includes('SKOWNSECRET'), false);

    // A drive viewer: the same.
    const reader = await approved('own-reader');
    await db.upsertPerson(reader, { roleId: 'member' });
    await db.grantFilespaceAccess({ filespaceId: fs.id, email: reader, role: 'viewer' });
    assert.equal((await call(reader)).status, 403);

    // Someone at their quota mounts read-only, so: the same.
    const full = await approved('own-full');
    await db.upsertPerson(full, { roleId: 'member' });
    await db.updatePerson(full, { quotaBytes: 0 });
    await db.grantFilespaceAccess({ filespaceId: fs.id, email: full, role: 'editor' });
    assert.equal((await call(full)).status, 403);

    // An editor with room gets the drive's key, as before.
    const editor = await approved('own-editor');
    await db.upsertPerson(editor, { roleId: 'member' });
    await db.grantFilespaceAccess({ filespaceId: fs.id, email: editor, role: 'editor' });
    const ok = await call(editor);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.role, 'editor');
    assert.equal(ok.body.accessKeyId, 'AKOWNKEY');
  });
});
