// Transcripts end to end: the real route handlers against a real database,
// with only the session stubbed ('@/auth' → whoever the test says). Runs with
// TEST_DATABASE_URL pointing at a throwaway database, and skips without one.
//
// What only a database can show: that the claim is atomic, that the
// claimer-only writes really are, that a lapsed lease comes back, that the
// queue holds to the drive boundary and the write rule, that a purge takes
// the row, and that a moved file's transcript follows it.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';

const URL_ = process.env.TEST_DATABASE_URL;
async function reachable(url) {
  if (!url) return false;
  const { default: postgres } = await import('postgres');
  const probe = postgres(url, { max: 1, connect_timeout: 3, idle_timeout: 1 });
  try { await probe`SELECT 1`; return true; } catch { return false; } finally { await probe.end({ timeout: 2 }).catch(() => {}); }
}
const live = await reachable(URL_);
process.env.DATABASE_URL = live ? URL_ : 'postgres://onyx:onyx@127.0.0.1:1/onyx';
process.env.ADMIN_EMAILS = 'boss@tx.test';
const skip = !live && 'TEST_DATABASE_URL not reachable';

// A request's session: the one it was started under (so two can run at
// once, as two Macs), else whoever the test last signed in.
globalThis.__txAls = new AsyncLocalStorage();
const STUB = `data:text/javascript,${encodeURIComponent('export async function auth() { return globalThis.__txAls.getStore() || globalThis.__txSession || null; }')}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: STUB, shortCircuit: true };
    return next(specifier, context);
  },
});
const as = (email) => { globalThis.__txSession = email ? { user: { email } } : null; };
const asFor = (email, fn) => globalThis.__txAls.run({ user: { email } }, fn);

const db = await import('../lib/db.js');
const route = await import('../app/api/files/[id]/transcript/route.js');
const claimRoute = await import('../app/api/files/[id]/transcript/claim/route.js');
const queueRoute = await import('../app/api/transcripts/queue/route.js');

const tag = Math.random().toString(36).slice(2, 8);
const OWNER = `owner-${tag}@tx.test`;     // uploader, an editor of the drive
const OTHER = `other-${tag}@tx.test`;     // another editor of the drive, with a Mac
const VIEWER = `viewer-${tag}@tx.test`;   // a Member, and a viewer of the drive
const OUTSIDER = `out-${tag}@tx.test`;    // a Member in no drive
const BOSS = 'boss@tx.test';               // an admin
const PREFIX = `tx-${tag}`;
const SECRET = `txs-${tag}`;

async function call(handler, id, method, body) {
  const res = await handler(new Request(`http://app.test/api/files/${id}/transcript`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }), { params: { id } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const queue = async () => {
  const res = await queueRoute.GET(new Request('http://app.test/api/transcripts/queue'));
  return { status: res.status, body: await res.json().catch(() => null) };
};
const ids = (q) => q.body.jobs.map((j) => j.fileId);

let drive; let secretDrive;
let cut; let mine; let theirs; let secret; let binned;
const made = [];

before(async () => {
  if (!live) return;
  await db.ensureSchema();
  drive = await db.createFilespace({ name: `Tx ${tag}`, bucket: 'b', prefix: PREFIX, createdBy: BOSS });
  secretDrive = await db.createFilespace({ name: `Txs ${tag}`, bucket: 'b', prefix: SECRET, createdBy: BOSS });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: OWNER, role: 'editor' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: OTHER, role: 'editor' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: VIEWER, role: 'viewer' });
  for (const email of [OWNER, OTHER, VIEWER, OUTSIDER]) await db.adminAddApprovedInvite({ email, name: email, reviewedBy: 'test' });
  const video = (name, key, by, extra = {}) => db.createFile({
    name, url: `http://s3.test/b/${key}`, mime: 'video/mp4', kind: 'video', size: 1000, storage: 's3', storageKey: key, createdBy: by, ...extra,
  });
  cut = await video('cut.mp4', `${PREFIX}/cut.mp4`, OWNER);
  mine = await video('mine.mp4', `files/mine-${tag}.mp4`, OWNER);          // the library, org-visible, OWNER's
  theirs = await video('theirs.mp4', `files/theirs-${tag}.mp4`, BOSS);     // the library, org-visible, not OWNER's
  secret = await video('secret.mp4', `${SECRET}/secret.mp4`, BOSS);        // a drive OWNER is not in
  binned = await video('binned.mp4', `${PREFIX}/binned.mp4`, OWNER);
  made.push(cut.id, mine.id, theirs.id, secret.id, binned.id);
  // Every job queued, in this order, by an admin (who may request any of them).
  as(BOSS);
  for (const f of [cut, mine, theirs, secret, binned]) {
    const r = await call(route.POST, f.id, 'POST', {});
    assert.equal(r.status, 200, f.name);
  }
  await db.softDeleteFile(binned.id, { deletedBy: OWNER });
});

after(async () => {
  if (live) {
    for (const id of made) await db.deleteFile(id).catch(() => {});
    await db.sql`DELETE FROM file_tombstones WHERE id = ANY(${made})`.catch(() => {});
    for (const d of [drive, secretDrive]) if (d) await db.deleteFilespace(d.id).catch(() => {});
    await db.sql`DELETE FROM invite_requests WHERE email LIKE ${`%-${tag}@tx.test`}`.catch(() => {});
  }
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

describe('transcripts against a real database', { skip }, () => {
  test('the queue holds to drives and to the write rule, and skips the trash', async () => {
    as(OWNER);
    const own = await queue();
    assert.equal(own.status, 200);
    assert.deepEqual(ids(own), [cut.id, mine.id], 'their drive’s job and their own upload — not an org file they only see, not another drive');
    as(VIEWER);
    assert.deepEqual(ids(await queue()), [], 'a drive viewer may change nothing in it, nor others’ uploads');
    as(OUTSIDER);
    assert.deepEqual(ids(await queue()), [], 'sees the library, may change none of it');
    as(BOSS);
    assert.deepEqual(ids(await queue()), [cut.id, mine.id, theirs.id, secret.id], 'an admin: everything but the trash');
    const job = (await queue()).body.jobs[0];
    assert.deepEqual(Object.keys(job).sort(), ['fileId', 'language', 'mime', 'name', 'requestedAt', 'size']);
    assert.match(job.requestedAt, /^\d{4}-\d\d-\d\dT/);
  });

  test('a trashed file is not served, not requestable, not claimable', async () => {
    as(OWNER);
    assert.equal((await call(route.GET, binned.id, 'GET')).status, 404);
    assert.equal((await call(route.POST, binned.id, 'POST', {})).status, 404);
    assert.equal((await call(claimRoute.POST, binned.id, 'POST', { device: 'x' })).status, 404);
  });

  test('two Macs claiming at once: exactly one gets the job', async () => {
    const [a, b] = await Promise.all([
      asFor(OWNER, () => call(claimRoute.POST, cut.id, 'POST', { device: 'Mac A' })),
      asFor(OTHER, () => call(claimRoute.POST, cut.id, 'POST', { device: 'Mac B' })),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const loser = a.status === 409 ? a : b;
    assert.equal(loser.body.code, 'taken');
    const [row] = await db.sql`SELECT status, claimed_by, claimed_device, lease_until > now() + interval '9 minutes' AS leased, source_key FROM transcripts WHERE file_id = ${cut.id}`;
    assert.equal(row.status, 'working');
    assert.ok(row.leased);
    assert.equal(row.source_key, cut.storageKey);
    // Whoever won keeps it; the other is told it is not theirs.
    const winner = row.claimed_by;
    const other = winner === OWNER ? OTHER : OWNER;
    as(other);
    const lost = await call(route.PATCH, cut.id, 'PATCH', { progress: 0.5 });
    assert.equal(lost.status, 409);
    assert.equal(lost.body.code, 'lost');
    as(winner);
    assert.equal((await call(route.PATCH, cut.id, 'PATCH', { progress: 0.25 })).status, 200);
    // A working job with a live lease is nobody else's queue item.
    as(other);
    assert.ok(!ids(await queue()).includes(cut.id));
  });

  test('a lapsed lease is claimable again, and the first Mac has lost it', async () => {
    const [{ claimed_by: first }] = await db.sql`SELECT claimed_by FROM transcripts WHERE file_id = ${cut.id}`;
    const second = first === OWNER ? OTHER : OWNER;
    await db.sql`UPDATE transcripts SET lease_until = now() - interval '1 minute' WHERE file_id = ${cut.id}`;
    as(second);
    assert.ok(ids(await queue()).includes(cut.id), 'back in the queue');
    const c = await call(claimRoute.POST, cut.id, 'POST', { device: 'Mac C' });
    assert.equal(c.status, 200);
    assert.equal(c.body.leaseSeconds, 600);
    as(first);
    assert.equal((await call(route.PUT, cut.id, 'PUT', { segments: [{ s: 0, e: 1, t: 'late' }] })).body.code, 'lost');
    as(second);
    const done = await call(route.PUT, cut.id, 'PUT', {
      segments: [{ s: 1.5, e: 3, t: 'Second.' }, { s: 0, e: 1.5, t: 'First.' }], resultLanguage: 'en-US', engine: 'apple-sfspeech', sourceKey: c.body.sourceKey,
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.transcript.status, 'done');
    assert.deepEqual(done.body.transcript.segments.map((x) => x.t), ['First.', 'Second.']);
    const [row] = await db.sql`SELECT text, lease_until, progress, finished_at FROM transcripts WHERE file_id = ${cut.id}`;
    assert.equal(row.text, 'First. Second.');
    assert.equal(row.lease_until, null);
    assert.equal(row.progress, 1);
    assert.ok(row.finished_at);
  });

  test('a drive viewer reads it and is offered nothing; an outsider cannot see it', async () => {
    as(VIEWER);
    const r = await call(route.GET, cut.id, 'GET');
    assert.equal(r.status, 200);
    assert.equal(r.body.transcript.segments.length, 2);
    assert.equal(r.body.canRequest, false);
    assert.equal(r.body.canDelete, false);
    assert.equal((await call(route.POST, cut.id, 'POST', {})).status, 403);
    assert.equal((await call(route.DELETE, cut.id, 'DELETE')).status, 403);
    as(OUTSIDER);
    assert.equal((await call(route.GET, cut.id, 'GET')).status, 404);
  });

  test('a rename keeps the transcript current; new bytes under a new key make it stale', async () => {
    as(OWNER);
    await db.setFileStorageKey(cut.id, `${PREFIX}/renamed.mp4`);
    assert.equal((await call(route.GET, cut.id, 'GET')).body.transcript.stale, false, 'same bytes, new name');
    await db.sql`UPDATE files SET storage_key = ${`${PREFIX}/renamed v2.mp4`} WHERE id = ${cut.id}`;
    assert.equal((await call(route.GET, cut.id, 'GET')).body.transcript.stale, true);
  });

  test('re-requesting keeps the old segments until a new run replaces them', async () => {
    as(OWNER);
    const r = await call(route.POST, cut.id, 'POST', { language: 'en-GB' });
    assert.equal(r.body.transcript.status, 'queued');
    assert.equal(r.body.transcript.segments.length, 2);
    assert.equal(r.body.transcript.stale, false, 'only a finished transcript is stale');
  });

  test('purging a file takes its transcript with it', async () => {
    await db.deleteFile(mine.id);
    const rows = await db.sql`SELECT 1 FROM transcripts WHERE file_id = ${mine.id}`;
    assert.equal(rows.length, 0);
  });

  test('DELETE removes it', async () => {
    as(OWNER);
    assert.deepEqual((await call(route.DELETE, cut.id, 'DELETE')).body, { ok: true });
    assert.equal((await call(route.GET, cut.id, 'GET')).body.transcript, null);
  });
});
