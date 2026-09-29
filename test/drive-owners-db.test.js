// A drive always has an owner (lib/drive-access.js), against a real Postgres
// and through the real routes: the one-click fix for drives that have none,
// a drive an admin makes, the last owner removed or demoted, a person
// removed who was a drive's only owner — and what a device makes of an
// admin's owner row, which is nothing.
//
// Runs only with TEST_DATABASE_URL (a database you can write to), and skips
// cleanly without one. '@/auth' is whoever the test says is signed in, as in
// test/mac-writes-api.test.js; everything after it — the session check,
// requireAdmin and requirePrincipal, the routes, lib/db.js — is the real
// code. Every row it makes is tagged with a random suffix and removed at
// the end, so it can share a database with the rest of the suite.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

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

const T = `o${Math.random().toString(36).slice(2, 8)}`;
const at = (name) => `${name}.${T}@example.com`;
const ADMIN = at('admin');
const ADMIN2 = at('admin2');

const AUTH_STUB = `data:text/javascript,${encodeURIComponent('export async function auth() { return globalThis.__owners?.session || null; }')}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: AUTH_STUB, shortCircuit: true };
    return next(specifier, context);
  },
});
globalThis.__owners = { session: null };
const signIn = (email) => { globalThis.__owners.session = email ? { user: { email } } : null; };

describeDb('every drive has an owner (database)', () => {
  let db, authz, syncScope, driveAccess, routes;
  const made = { emails: new Set([ADMIN, ADMIN2]), filespaces: [] };

  before(async () => {
    process.env.DATABASE_URL = URL_;
    process.env.ADMIN_EMAILS = `${ADMIN},${ADMIN2}`;
    process.env.SUPER_ADMIN_EMAILS = '';
    process.env.SCHEMA_MANAGED = '0';
    db = await import('../lib/db.js');
    const results = await db.ensureSchema();
    assert.deepEqual(results.filter((r) => !r.ok), [], 'every guard runs on this database');
    authz = await import('../lib/authz.js');
    syncScope = await import('../lib/sync-scope.js');
    driveAccess = await import('../lib/drive-access.js');
    routes = {
      claim: await import('../app/api/admin/filespaces/claim/route.js'),
      filespaces: await import('../app/api/admin/filespaces/route.js'),
      members: await import('../app/api/filespaces/[id]/members/route.js'),
      person: await import('../app/api/admin/people/[id]/route.js'),
      personDrives: await import('../app/api/admin/people/[id]/drives/route.js'),
      invites: await import('../app/api/admin/invites/route.js'),
    };
  });

  after(async () => {
    signIn(null);
    if (!db) return;
    for (const e of made.emails) await db.removePerson(e, { apply: true }).catch(() => {});
    for (const id of made.filespaces) await db.deleteFilespace(id).catch(() => {});
    await db.sql`DELETE FROM audit_events WHERE actor LIKE ${`%.${T}@example.com`} OR subject_id LIKE ${`%.${T}@example.com`}`.catch(() => {});
    await db.sql.end({ timeout: 5 }).catch(() => {});
  });

  // Someone who may sign in: an approved invite and a people row.
  const person = async (name) => {
    const e = at(name);
    made.emails.add(e);
    await db.adminAddApprovedInvite({ email: e, reviewedBy: ADMIN });
    await db.upsertPerson(e, { roleId: 'member' });
    return db.getPersonByEmail(e);
  };
  // A drive with these members ({ email: role }), made without an owner of
  // its own unless one is among them — as every drive an admin made was.
  const drive = async (name, members = {}) => {
    const fs = await db.createFilespace({ name: `${name} ${T}`, bucket: 'b', prefix: `${name.toLowerCase()}-${T}`, createdBy: ADMIN });
    made.filespaces.push(fs.id);
    for (const [email, role] of Object.entries(members)) {
      await db.grantFilespaceAccess({ filespaceId: fs.id, email, role, grantedBy: ADMIN });
    }
    return fs;
  };
  const roles = async (fs) => Object.fromEntries((await db.listFilespaceMembers(fs.id)).map((m) => [m.email, m.role]));
  const call = async (mod, method, { params = {}, body, url = 'http://localhost/api/x' } = {}) => {
    const res = await mod[method](new Request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), { params });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  };
  const member = (fs, body) => call(routes.members, 'PATCH', { params: { id: fs.id }, body });
  const claimsOf = async (ids) => (await db.listAuditEvents({ action: 'drive.claim', limit: 500 }))
    .filter((e) => ids.includes(e.subject?.id));

  test("Overview's fix: the admin owns each named drive that has no owner, and nothing else changes", async () => {
    const viewer = (await person('claim-viewer')).email;
    const owner = (await person('claim-owner')).email;
    const empty = await drive('Empty');
    const viewed = await drive('Viewed', { [viewer]: 'viewer' });
    const owned = await drive('Owned', { [owner]: 'owner' });
    const unnamed = await drive('Unnamed');

    signIn(ADMIN);
    const r = await call(routes.claim, 'POST', { body: { ids: [empty.id, viewed.id, owned.id, `gone-${T}`] } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(r.body.claimed.map((d) => d.id).sort(), [empty.id, viewed.id].sort());
    assert.deepEqual(r.body.skipped.sort(), [owned.id, `gone-${T}`].sort());
    assert.deepEqual(await roles(empty), { [ADMIN]: 'owner' });
    assert.deepEqual(await roles(viewed), { [viewer]: 'viewer', [ADMIN]: 'owner' }, 'its members stay as they were');
    assert.deepEqual(await roles(owned), { [owner]: 'owner' }, 'a drive with an owner is left alone');
    assert.deepEqual(await roles(unnamed), {}, 'a drive the confirm did not name is not touched');

    // What Admin → Overview counts, and what the audit trail says.
    const counts = new Map((await db.listDriveOwners()).map((d) => [d.id, d.ownerCount]));
    assert.deepEqual([empty, viewed, owned, unnamed].map((d) => counts.get(d.id)), [1, 1, 1, 0]);
    const claims = await claimsOf([empty.id, viewed.id, owned.id]);
    assert.deepEqual(claims.map((e) => e.subject.id).sort(), [empty.id, viewed.id].sort());
    assert.ok(claims.every((e) => e.actor === ADMIN && e.detail === null), 'one row per drive, by the admin');

    const again = await call(routes.claim, 'POST', { body: { ids: [empty.id, viewed.id] } });
    assert.deepEqual(again.body.claimed, [], 'nothing left to claim');
    assert.equal(again.body.skipped.length, 2);
  });

  test('the fix is an admin route: no session, no admin, no list — nothing is claimed', async () => {
    const someone = (await person('claim-member')).email;
    const fs = await drive('Guarded');
    signIn(null);
    assert.equal((await call(routes.claim, 'POST', { body: { ids: [fs.id] } })).status, 401);
    signIn(someone);
    assert.equal((await call(routes.claim, 'POST', { body: { ids: [fs.id] } })).status, 403);
    signIn(ADMIN);
    for (const body of [{}, { ids: [] }, { ids: 'x' }]) {
      assert.equal((await call(routes.claim, 'POST', { body })).status, 400, JSON.stringify(body));
    }
    assert.deepEqual(await roles(fs), {});
  });

  test('a drive an admin makes is theirs, from the same statement that makes it', async () => {
    signIn(ADMIN);
    const r = await call(routes.filespaces, 'POST', { body: { name: `Made ${T}`, bucket: 'b', prefix: `made-${T}` } });
    assert.equal(r.status, 200);
    made.filespaces.push(r.body.filespace.id);
    assert.deepEqual(await roles(r.body.filespace), { [ADMIN]: 'owner' });
    const [created] = await db.listAuditEvents({ actor: ADMIN, action: 'drive.create', subjectId: r.body.filespace.id });
    assert.equal(created.detail.owner, ADMIN);

    // The self-serve route's half: whoever it is made for owns it.
    const maker = (await person('maker')).email;
    const mine = await db.createFilespace({ name: `Mine ${T}`, bucket: 'b', prefix: `mine-${T}`, createdBy: maker, owner: maker });
    made.filespaces.push(mine.id);
    assert.deepEqual(await roles(mine), { [maker]: 'owner' });
  });

  test('the last owner removed or demoted by an admin: the admin owns the drive instead', async () => {
    const owner = (await person('last-owner')).email;
    const viewer = (await person('last-viewer')).email;
    const other = (await person('other-owner')).email;
    signIn(ADMIN);

    const removed = await drive('Removed', { [owner]: 'owner', [viewer]: 'viewer' });
    let r = await member(removed, { email: owner, grant: false });
    assert.equal(r.status, 200);
    assert.equal(r.body.claimedBy, ADMIN);
    assert.deepEqual(await roles(removed), { [viewer]: 'viewer', [ADMIN]: 'owner' });

    const demoted = await drive('Demoted', { [owner]: 'owner' });
    r = await member(demoted, { email: owner, role: 'editor' });
    assert.equal(r.status, 200);
    assert.equal(r.body.claimedBy, ADMIN);
    assert.equal(r.body.member.role, 'editor');
    assert.deepEqual(await roles(demoted), { [owner]: 'editor', [ADMIN]: 'owner' });

    // Another owner stays: there is nothing to take on.
    const shared = await drive('Shared', { [owner]: 'owner', [other]: 'owner' });
    r = await member(shared, { email: owner, grant: false });
    assert.equal(r.body.claimedBy, null);
    assert.deepEqual(await roles(shared), { [other]: 'owner' });

    const claims = await claimsOf([removed.id, demoted.id, shared.id]);
    assert.deepEqual(claims.map((e) => e.subject.id).sort(), [removed.id, demoted.id].sort());
    assert.ok(claims.every((e) => e.detail?.from === owner), 'each says whose change it answered');
  });

  test('an admin is a member only as an owner, and as the only one cannot step down', async () => {
    const fs = await drive('Solo');
    signIn(ADMIN);
    assert.equal((await member(fs, { email: ADMIN, role: 'editor' })).status, 400);
    assert.equal((await member(fs, { email: ADMIN, role: 'owner' })).status, 200);
    const refused = await member(fs, { email: ADMIN, grant: false });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'last_owner');
    assert.match(refused.body.error, /only owner/);
    assert.deepEqual(await roles(fs), { [ADMIN]: 'owner' }, 'nothing was removed');

    // Another admin may: they become the owner as they do it.
    signIn(ADMIN2);
    const handed = await member(fs, { email: ADMIN, grant: false });
    assert.equal(handed.status, 200);
    assert.equal(handed.body.claimedBy, ADMIN2);
    assert.deepEqual(await roles(fs), { [ADMIN2]: 'owner' });
  });

  test('an owner who is not an admin never leaves a drive with none', async () => {
    const a = (await person('team-a')).email;
    const b = (await person('team-b')).email;
    const fs = await drive('Team', { [a]: 'owner', [b]: 'owner' });
    signIn(a);
    const r = await member(fs, { email: b, grant: false });
    assert.equal(r.status, 200);
    assert.equal(r.body.claimedBy, null);
    assert.equal((await member(fs, { email: a, grant: false })).status, 403, 'not their own grant');
    assert.deepEqual(await roles(fs), { [a]: 'owner' });

    // And the statement refuses by itself when nobody may take the drive on.
    const revoke = await db.revokeFilespaceAccess({ filespaceId: fs.id, email: a });
    assert.equal(revoke.refused, true);
    const demote = await db.grantFilespaceAccess({ filespaceId: fs.id, email: a, role: 'viewer' });
    assert.deepEqual({ refused: demote.refused, member: demote.member }, { refused: true, member: null });
    assert.deepEqual(await roles(fs), { [a]: 'owner' }, 'nothing was written');
    // Anyone who is not the last owner comes and goes as before.
    await db.grantFilespaceAccess({ filespaceId: fs.id, email: b, role: 'viewer' });
    assert.equal((await db.revokeFilespaceAccess({ filespaceId: fs.id, email: b })).removed, true);
  });

  test('removing a person who was a drive’s only owner hands it to the admin removing them', async () => {
    const leaving = await person('leaving');
    const viewer = (await person('stays')).email;
    const coOwner = (await person('co-owner')).email;
    const sole = await drive('Sole', { [leaving.email]: 'owner', [viewer]: 'viewer' });
    const co = await drive('Co', { [leaving.email]: 'owner', [coOwner]: 'owner' });
    const seen = await drive('Seen', { [leaving.email]: 'viewer' });
    signIn(ADMIN);

    const preview = await call(routes.person, 'DELETE', { url: 'http://localhost/api/admin/people/x?preview=1', params: { id: leaving.id } });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.preview.soleOwnerOf, [{ id: sole.id, name: sole.name }]);
    assert.deepEqual(await roles(sole), { [leaving.email]: 'owner', [viewer]: 'viewer' }, 'a preview changes nothing');

    const done = await call(routes.person, 'DELETE', { params: { id: leaving.id } });
    assert.equal(done.status, 200);
    assert.deepEqual(done.body.removed.claimed, [{ id: sole.id, name: sole.name }]);
    assert.deepEqual(await roles(sole), { [viewer]: 'viewer', [ADMIN]: 'owner' });
    assert.deepEqual(await roles(co), { [coOwner]: 'owner' }, 'another owner stays, and the admin is not added');
    assert.deepEqual(await roles(seen), {}, 'a drive they only viewed has no one to hand on');
    const claims = await claimsOf([sole.id, co.id, seen.id]);
    assert.deepEqual(claims.map((e) => [e.subject.id, e.detail?.from]), [[sole.id, leaving.email]]);

    // The same from Access requests, which removes by address.
    const gone = (await person('by-address')).email;
    const byAddress = await drive('ByAddress', { [gone]: 'owner' });
    const r = await call(routes.invites, 'DELETE', { url: `http://localhost/api/admin/invites?email=${encodeURIComponent(gone)}` });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.removed.claimed.map((d) => d.id), [byAddress.id]);
    assert.deepEqual(await roles(byAddress), { [ADMIN]: 'owner' });
  });

  test('Admin → People → drives: taking someone’s only-owner grant makes the admin the owner', async () => {
    const p = await person('regrant');
    const lowered = await drive('Lowered', { [p.email]: 'owner' });
    const dropped = await drive('Dropped', { [p.email]: 'owner' });
    signIn(ADMIN);
    const r = await call(routes.personDrives, 'PUT', { params: { id: p.id }, body: { grants: [{ filespaceId: lowered.id, role: 'viewer' }] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.claimed.map((d) => d.id).sort(), [lowered.id, dropped.id].sort());
    assert.deepEqual(r.body.refused, []);
    assert.deepEqual(await roles(lowered), { [p.email]: 'viewer', [ADMIN]: 'owner' });
    assert.deepEqual(await roles(dropped), { [ADMIN]: 'owner' });
  });

  test('devices: an admin’s owner row changes nothing an admin sees; the person taken off learns of it', async () => {
    const p = await person('synced');
    const fs = await drive('Synced', { [p.email]: 'owner' });
    // Where the drives are is part of the fingerprint, and other tests make
    // drives at the same time: hold it still, so only who may see what moves.
    const where = driveAccess.drivePatterns([fs]);
    const tag = async (email) => syncScope.accessFingerprint(await authz.getPrincipal(email), where);
    const adminBefore = await tag(ADMIN);
    const personBefore = await tag(p.email);

    signIn(ADMIN);
    const r = await member(fs, { email: p.email, grant: false });
    assert.equal(r.body.claimedBy, ADMIN);
    assert.equal(await tag(ADMIN), adminBefore, 'the admin reached the drive before and reaches it now: their feed carries on');
    assert.notEqual(await tag(p.email), personBefore, 'their devices start again, without the drive');

    // The admin's drive list is every drive, once each, as owner — the row
    // adds no second entry.
    const list = await db.listFilespacesForSpace(ADMIN);
    assert.equal(list.filter((f) => f.id === fs.id).length, 1);
    assert.equal(list.find((f) => f.id === fs.id).role, 'owner');
    assert.equal(new Set(list.map((f) => f.id)).size, list.length);
  });
});
