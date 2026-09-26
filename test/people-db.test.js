// The Phase 1 tables against a real Postgres: people, suspension and the
// session cutoff, removal, the audit trail, maintenance runs, the links and
// trash admin lists, and the principal the web and the desktop share.
//
// Runs only with TEST_DATABASE_URL (a database you can write to), and skips
// cleanly without one, like the other database tests. Every row it makes is
// tagged with a random suffix and removed at the end, so it can share a
// database with the rest of the suite.

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

const T = `t${Math.random().toString(36).slice(2, 8)}`;
const at = (name) => `${name}.${T}@example.com`;
const ADMIN = at('admin');

describeDb('people, sessions and the admin tables (database)', () => {
  let db, authz, maintenance, guard;
  const made = { emails: new Set(), filespaces: [], files: [] };

  before(async () => {
    process.env.DATABASE_URL = URL_;
    process.env.ADMIN_EMAILS = ADMIN;
    process.env.SCHEMA_MANAGED = '0';
    db = await import('../lib/db.js');
    const results = await db.ensureSchema();
    assert.deepEqual(results.filter((r) => !r.ok), [], 'every guard runs on this database');
    authz = await import('../lib/authz.js');
    maintenance = await import('../lib/maintenance.js');
    guard = await import('../lib/desktop-guard.js');
  });

  after(async () => {
    if (!db) return;
    for (const e of made.emails) await db.removePerson(e, { apply: true }).catch(() => {});
    for (const id of made.files) await db.sql`DELETE FROM files WHERE id = ${id}`.catch(() => {});
    for (const id of made.filespaces) await db.deleteFilespace(id).catch(() => {});
    await db.sql`DELETE FROM audit_events WHERE actor LIKE ${`%.${T}@example.com`} OR subject_id LIKE ${`%.${T}@example.com`}`.catch(() => {});
    await db.sql.end({ timeout: 5 }).catch(() => {});
  });

  async function person(name, { approved = true, roleId = null } = {}) {
    const e = at(name);
    made.emails.add(e);
    if (approved) await db.adminAddApprovedInvite({ email: e, reviewedBy: ADMIN });
    await db.upsertPerson(e, { roleId });
    return db.getPersonByEmail(e);
  }

  test('a person row is made once and never overwritten', async () => {
    const p = await person('once', { roleId: 'viewer' });
    assert.equal(p.roleId, 'viewer');
    assert.equal(p.status, 'active');
    assert.equal(p.firstSeenAt, null, 'invited, not yet seen');
    const again = await db.upsertPerson(p.email, { seen: true, roleId: 'member' });
    assert.equal(again.roleId, 'viewer', 'a sign-in does not reset the role');
    assert.ok(again.firstSeenAt, 'seen now');
    assert.equal((await db.getPersonById(p.id)).email, p.email);
  });

  test('suspension closes the gate, and reactivating opens it', async () => {
    const p = await person('suspend');
    assert.equal(await db.isEmailApprovedInvite(p.email), true);
    const token = await db.createDesktopToken({ email: p.email, label: 'Mac' });
    const { devices } = await db.setPersonStatus(p.email, { status: 'suspended', reason: 'Left', by: ADMIN });
    assert.equal(devices, 1, 'the desktop token is gone');
    assert.equal(await db.getDesktopTokenByRaw(token.token), null);
    assert.equal(await db.isEmailApprovedInvite(p.email), false);
    const s = await db.getPersonByEmail(p.email);
    assert.equal(s.status, 'suspended');
    assert.equal(s.statusReason, 'Left');
    assert.ok(s.sessionsValidAfter, 'web sessions from before now are over');
    assert.equal(await db.isLinkCreatorPaused(p.email), true);

    await db.setPersonStatus(p.email, { status: 'active', by: ADMIN });
    assert.equal(await db.isEmailApprovedInvite(p.email), true);
    assert.equal(await db.isLinkCreatorPaused(p.email), false);
  });

  test('suspending without pausing links leaves them serving', async () => {
    const p = await person('nopause');
    await db.setPersonStatus(p.email, { status: 'suspended', by: ADMIN, pauseLinks: false });
    assert.equal(await db.isLinkCreatorPaused(p.email), false);
  });

  test('the session row: person, invite, picture and device in one query', async () => {
    const p = await person('session');
    const token = await db.createDesktopToken({ email: p.email, label: 'Mac' });
    const row = await db.sessionRowFor(p.email, token.id);
    assert.equal(row.person.email, p.email);
    assert.equal(row.inviteStatus, 'approved');
    assert.equal(row.avatar, null);
    assert.equal(row.deviceOk, true);
    await db.revokeDesktopToken(token.id);
    assert.equal((await db.sessionRowFor(p.email, token.id)).deviceOk, false);
    // Someone else's token id does not count as theirs.
    const other = await person('session-other');
    const theirs = await db.createDesktopToken({ email: other.email });
    assert.equal((await db.sessionRowFor(p.email, theirs.id)).deviceOk, false);
    // No row at all: still one answer, with a null person.
    const ghost = await db.sessionRowFor(at('ghost'));
    assert.equal(ghost.person, null);
    assert.equal(ghost.inviteStatus, null);
  });

  test('sign out everywhere moves the cutoff and revokes every device', async () => {
    const p = await person('signout');
    await db.createDesktopToken({ email: p.email });
    await db.createDesktopToken({ email: p.email });
    const before = Date.now();
    const { devices } = await db.signOutEverywhere(p.email);
    assert.equal(devices, 2);
    assert.ok((await db.getPersonByEmail(p.email)).sessionsValidAfter >= before);
  });

  test('the backfill seeds everyone once and copies v1 assignments only onto empty roles', async () => {
    const signedIn = at('backfill-user');
    const approved = at('backfill-invite');
    const kept = at('backfill-kept');
    made.emails.add(signedIn).add(approved).add(kept);
    await db.getOrCreateAuthUser(signedIn);
    await db.adminAddApprovedInvite({ email: approved, reviewedBy: ADMIN });
    await db.adminAddApprovedInvite({ email: kept, reviewedBy: ADMIN });
    await db.upsertPerson(kept, { roleId: 'contributor' });
    const r = await db.backfillPeople({
      adminEmails: [ADMIN],
      assignments: { [signedIn]: 'viewer', [kept]: 'viewer', [approved.toUpperCase()]: 'admin' },
    });
    assert.ok(r.added >= 2);
    assert.equal((await db.getPersonByEmail(signedIn)).roleId, 'viewer');
    assert.ok((await db.getPersonByEmail(signedIn)).firstSeenAt, 'a signed-in user counts as seen');
    assert.equal((await db.getPersonByEmail(kept)).roleId, 'contributor', 'an admin-set role is not overwritten');
    assert.equal((await db.getPersonByEmail(approved)).roleId, 'admin', 'the retired role is copied, so the banner can find it');
    assert.ok(await db.getPersonByEmail(ADMIN), 'env admins get a row');
    made.emails.add(ADMIN);
    assert.ok((await db.peopleWithRoles(['admin'])).includes(approved));
  });

  test('the People list filters, counts and sorts', async () => {
    const a = await person('list-a');
    const b = await person('list-b', { roleId: 'viewer' });
    await db.upsertPerson(a.email, { seen: true });
    await db.setPersonStatus(b.email, { status: 'suspended', by: ADMIN });
    const q = `.${T}@`;
    const all = await db.listPeople({ q, adminEmails: [ADMIN] });
    assert.ok(all.rows.some((r) => r.person.email === a.email));
    const suspended = await db.listPeople({ q, status: 'suspended', adminEmails: [ADMIN] });
    assert.ok(suspended.rows.some((r) => r.person.email === b.email));
    assert.ok(suspended.rows.every((r) => r.person.status === 'suspended'));
    assert.ok(!suspended.rows.some((r) => r.person.email === a.email));
    const viewers = await db.listPeople({ q, roleIds: ['viewer'], adminEmails: [ADMIN] });
    assert.ok(viewers.rows.every((r) => r.person.roleId === 'viewer'));
    assert.ok(viewers.rows.some((r) => r.person.email === b.email));
    const members = await db.listPeople({ q, roleIds: ['member'], defaultRole: 'member', adminEmails: [ADMIN] });
    assert.ok(members.rows.some((r) => r.person.email === a.email), 'no role_id is the default role');
    for (const sort of ['active', 'name', 'storage']) {
      const page = await db.listPeople({ q, sort, adminEmails: [ADMIN], limit: 2 });
      assert.ok(page.rows.length <= 2);
      assert.ok(page.total >= page.rows.length);
    }
    const counts = await db.peopleCounts({ adminEmails: [ADMIN] });
    assert.ok(counts.all >= 2 && counts.suspended >= 1);
  });

  test('the drawer: drives, links, devices, usage', async () => {
    const p = await person('drawer');
    const fs = await db.createFilespace({ name: `Drawer ${T}`, bucket: 'b', prefix: `drawer-${T}`, createdBy: ADMIN });
    made.filespaces.push(fs.id);
    await db.grantFilespaceAccess({ filespaceId: fs.id, email: p.email, role: 'editor', grantedBy: ADMIN });
    const file = await db.createFile({ name: 'a.jpg', url: 'https://x/a.jpg', storage: 's3', storageKey: `drawer-${T}/a.jpg`, size: 1234, createdBy: p.email });
    made.files.push(file.id);
    await db.createShare({ fileId: file.id, createdBy: p.email, mode: 'public', expiresInDays: 7 });
    await db.createDesktopToken({ email: p.email, label: 'Studio Mac' });
    const d = await db.personDetail(p.email);
    assert.deepEqual(d.drives.map((x) => [x.filespaceId, x.role]), [[fs.id, 'editor']]);
    assert.equal(d.links.length, 1);
    assert.equal(d.links[0].kind, 'public');
    assert.equal(d.devices[0].label, 'Studio Mac');
    assert.deepEqual(d.usage, { files: 1, bytes: 1234 });
    assert.equal(await db.usedBytesBy(p.email), 1234);
  });

  test('removing a person takes their access and leaves their files', async () => {
    const p = await person('remove');
    const fs = await db.createFilespace({ name: `Remove ${T}`, bucket: 'b', prefix: `remove-${T}`, createdBy: ADMIN });
    made.filespaces.push(fs.id);
    await db.grantFilespaceAccess({ filespaceId: fs.id, email: p.email, role: 'viewer' });
    const file = await db.createFile({ name: 'r.jpg', url: 'https://x/r.jpg', size: 10, createdBy: p.email });
    made.files.push(file.id);
    await db.createShare({ fileId: file.id, createdBy: p.email, mode: 'public' });
    await db.createDesktopToken({ email: p.email });
    await db.getOrCreateAuthUser(p.email);

    const preview = await db.removePerson(p.email);
    assert.equal(preview.drives, 1);
    assert.equal(preview.devices, 1);
    assert.equal(preview.links, 1);
    assert.equal(preview.filesKept, 1);
    assert.ok(await db.getPersonByEmail(p.email), 'a preview changes nothing');

    await db.removePerson(p.email, { apply: true });
    assert.equal(await db.getPersonByEmail(p.email), null);
    assert.equal(await db.isEmailApprovedInvite(p.email), false);
    assert.equal((await db.listFilespacesForUser(p.email)).length, 0);
    assert.equal((await db.listDesktopTokens(p.email)).length, 0);
    assert.equal((await db.listSharesForFile(file.id)).length, 0);
    assert.ok(await db.getFileById(file.id), 'the file stays');
    assert.equal((await db.sql`SELECT 1 FROM "user" WHERE lower(email) = ${p.email}`).length, 0);
  });

  test('the audit trail: by or about a person, newest first, and pruned', async () => {
    const { audit, personSubject } = await import('../lib/audit.js');
    const p = at('audited');
    await audit(ADMIN, 'person.role', personSubject(p), { from: null, to: 'viewer' });
    await audit(p, 'share.revoke', { type: 'file', id: 'f1', label: 'a.jpg' });
    const about = await db.listAuditEvents({ person: p });
    assert.deepEqual(about.map((e) => e.action).sort(), ['person.role', 'share.revoke']);
    assert.equal((await db.listAuditEvents({ action: 'person', person: p })).length, 1, 'a family filter');
    // Never throws, even with nothing to write.
    assert.equal(await audit(ADMIN, null), null);
  });

  test('a maintenance run is recorded, from start to finish', async () => {
    const result = await maintenance.runMaintenance({ trigger: 'test', by: ADMIN });
    assert.ok(result.id);
    assert.equal(typeof result.durationMs, 'number');
    const [latest] = await db.listMaintenanceRuns({ limit: 1 });
    assert.equal(latest.id, result.id);
    assert.equal(latest.trigger, 'test');
    assert.equal(latest.triggeredBy, ADMIN);
    assert.ok(latest.finishedAt >= latest.startedAt);
    assert.equal(latest.ok, result.ok);
  });

  test('links: listed with their creator, filtered, and revoked in bulk', async () => {
    const p = await person('links');
    const file = await db.createFile({ name: 'l.jpg', url: 'https://x/l.jpg', createdBy: p.email });
    made.files.push(file.id);
    const pub = await db.createShare({ fileId: file.id, createdBy: p.email, mode: 'public', expiresInDays: 3 });
    const priv = await db.createShare({ fileId: file.id, createdBy: p.email, mode: 'private' });
    const mine = await db.listAllShares({ creator: p.email });
    assert.equal(mine.rows.length, 2);
    assert.equal((await db.listAllShares({ creator: p.email, kind: 'private' })).rows[0].token, priv.token);
    assert.equal((await db.listAllShares({ creator: p.email, expiringWithinMs: 7 * 864e5 })).rows[0].token, pub.token);
    await db.setPersonStatus(p.email, { status: 'suspended', by: ADMIN });
    assert.ok((await db.listAllShares({ creator: p.email })).rows.every((r) => r.creator === 'suspended' && r.paused));
    const gone = await db.deleteShares([pub.token, priv.token, 'not-a-token']);
    assert.equal(gone.length, 2);
  });

  test('trash: listed newest first, and restored with its trash flags cleared', async () => {
    const p = await person('trash');
    const file = await db.createFile({ name: 't.jpg', url: 'https://x/t.jpg', createdBy: p.email });
    made.files.push(file.id);
    await db.softDeleteFile(file.id, { deletedBy: p.email });
    const trashed = await db.getTrashedFiles([file.id, 'nope']);
    assert.equal(trashed.length, 1);
    assert.equal(trashed[0].deletedBy, p.email);
    const page = await db.listTrashedFiles({ limit: 500 });
    assert.ok(page.some((f) => f.id === file.id));
    const restored = await db.restoreFile(file.id);
    assert.equal(restored.deletedAt, null);
    assert.equal(restored.deletedBy, null);
    assert.equal(await db.restoreFile(file.id), null, 'a live file is not restored twice');
  });

  test('the principal: the drive ceiling applies, and web and desktop agree', async () => {
    const p = await person('parity', { roleId: 'viewer' });
    const fs = await db.createFilespace({ name: `Parity ${T}`, bucket: 'b', prefix: `parity-${T}`, createdBy: ADMIN });
    made.filespaces.push(fs.id);
    await db.grantFilespaceAccess({ filespaceId: fs.id, email: p.email, role: 'editor' });

    const web = await authz.getPrincipal(p.email, { person: await db.getPersonByEmail(p.email) });
    assert.equal(web.roleId, 'viewer');
    assert.equal(web.driveScope.roles[fs.id], 'viewer', 'granted editor, capped at viewer');
    assert.equal(await db.getFilespaceForWrite(p.email, fs.id, web), null);
    assert.ok(await db.getFilespaceForUser(p.email, fs.id, web));

    const token = await db.createDesktopToken({ email: p.email });
    const req = new Request('http://localhost/api/space/filespaces', { headers: { authorization: `Bearer ${token.token}` } });
    const gate = await guard.requireDesktopAuth(req);
    assert.ok(!gate.error, 'the token is accepted');
    const desktop = gate.principal;
    for (const action of ['files.upload', 'files.edit', 'files.delete', 'folders.manage', 'shares.private', 'shares.public', 'desktop.mount', 'admin']) {
      assert.deepEqual(authz.can(desktop, action, { canModify: true }), authz.can(web, action, { canModify: true }), action);
    }
    assert.deepEqual(desktop.driveScope.roles, web.driveScope.roles);
    assert.deepEqual(desktop.limits, web.limits);

    // Suspended: the desktop is refused on its next request.
    await db.setPersonStatus(p.email, { status: 'suspended', by: ADMIN });
    const token2 = await db.createDesktopToken({ email: p.email });
    const refused = await guard.requireDesktopAuth(new Request('http://localhost/x', { headers: { authorization: `Bearer ${token2.token}` } }));
    assert.equal(refused.error.status, 403);
  });

  test('a legacy full-role holder lists only the drives they are a member of', async () => {
    const p = await person('legacy', { roleId: 'admin' });
    const mine = await db.createFilespace({ name: `Mine ${T}`, bucket: 'b', prefix: `mine-${T}`, createdBy: ADMIN });
    const notMine = await db.createFilespace({ name: `Not mine ${T}`, bucket: 'b', prefix: `notmine-${T}`, createdBy: ADMIN });
    made.filespaces.push(mine.id, notMine.id);
    await db.grantFilespaceAccess({ filespaceId: mine.id, email: p.email, role: 'editor' });
    const token = await db.createDesktopToken({ email: p.email });
    const route = await import('../app/api/space/filespaces/route.js');
    const res = await route.GET(new Request('http://localhost/api/space/filespaces', { headers: { authorization: `Bearer ${token.token}` } }));
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.isAdmin, false);
    const ids = body.filespaces.map((f) => f.id);
    assert.ok(ids.includes(mine.id));
    assert.ok(!ids.includes(notMine.id), 'a full role no longer lists every drive');
  });

  test('STS for a Viewer: read-only, or refused where no read-only key exists', async () => {
    const p = await person('sts', { roleId: 'viewer' });
    const fs = await db.createFilespace({ name: `STS ${T}`, bucket: 'b', prefix: `sts-${T}`, createdBy: ADMIN });
    made.filespaces.push(fs.id);
    await db.grantFilespaceAccess({ filespaceId: fs.id, email: p.email, role: 'owner' });
    const token = await db.createDesktopToken({ email: p.email });
    const route = await import('../app/api/space/sts/route.js');
    const res = await route.POST(new Request('http://localhost/api/space/sts', {
      method: 'POST', headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ filespaceId: fs.id }),
    }));
    // No bucket is configured on the test database, so the route stops
    // before minting — the point is that it never gets as far as handing a
    // Viewer anything but a viewer's role (the role logic is mountRole,
    // tested in authz.test.js).
    assert.notEqual(res.status, 200);
  });
});
