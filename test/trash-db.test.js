// A person's Trash against a real Postgres: GET /api/files/trash and
// POST /api/files/trash/restore over lib/db.js's own SQL (buildTrashQuery,
// listTrashForUser, restoreFile). Who sees which deleted files is decided in
// that SQL — the listing's access rule and the drive's write rule — and a
// mistake there hands someone another drive's deleted files, so it is checked
// where it runs. Also: restoreFile's compare-and-set on trash_key, and a
// restored file reaching devices through the change feed.
//
// The rows here never moved to the trash (trash_key NULL), so no bucket is
// needed; the move back is test/mac-writes-api.test.js's and
// test/trash-restore.test.js's.
//
// Runs only with TEST_DATABASE_URL, and skips cleanly without one.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const URL_ = process.env.TEST_DATABASE_URL;
async function reachable(url) {
  if (!url) return false;
  const { default: postgres } = await import('postgres');
  const probe = postgres(url, { max: 1, connect_timeout: 3, idle_timeout: 1 });
  try { await probe`SELECT 1`; return true; } catch { return false; } finally { await probe.end({ timeout: 2 }).catch(() => {}); }
}
const live = await reachable(URL_);
process.env.DATABASE_URL = live ? URL_ : 'postgres://onyx:onyx@127.0.0.1:1/onyx';
process.env.ADMIN_EMAILS = 'boss@tr.test';
const describeDb = live ? describe : describe.skip;

const STUB = `data:text/javascript,${encodeURIComponent('export async function auth() { return globalThis.__trSession || null; }')}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: STUB, shortCircuit: true };
    return next(specifier, context);
  },
});
const as = (email) => { globalThis.__trSession = email ? { user: { email } } : null; };

const db = await import('../lib/db.js');
const { getPrincipal } = await import('../lib/authz.js');
const listRoute = await import('../app/api/files/trash/route.js');
const restoreRoute = await import('../app/api/files/trash/restore/route.js');

const tag = Math.random().toString(36).slice(2, 8);
const EDITOR = `ed-${tag}@tr.test`;     // an editor of the drive
const OTHER = `ed2-${tag}@tr.test`;     // another editor of it
const VIEWER = `view-${tag}@tr.test`;   // a Member, and a viewer of the drive
const OUTSIDER = `out-${tag}@tr.test`;  // a Member in no drive
const BOSS = 'boss@tr.test';
const PREFIX = `tr-${tag}`;
const SECRET = `trs-${tag}`;

async function list(email, cursor) {
  as(email);
  const res = await listRoute.GET(new Request(`http://app.test/api/files/trash${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`));
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function putBack(email, ids) {
  as(email);
  const res = await restoreRoute.POST(new Request('http://app.test/api/files/trash/restore', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }),
  }));
  return { status: res.status, body: await res.json().catch(() => null) };
}

let drive; let secretDrive;
const files = {};
const made = [];
const ours = (body) => (body?.files || []).map((f) => f.id).filter((id) => made.includes(id));

describeDb('a person’s Trash (database)', () => {
  before(async () => {
    await db.ensureSchema();
    drive = await db.createFilespace({ name: `Trash ${tag}`, bucket: 'onyx-tr', prefix: PREFIX, createdBy: BOSS });
    secretDrive = await db.createFilespace({ name: `Secret ${tag}`, bucket: 'onyx-tr', prefix: SECRET, createdBy: BOSS });
    await db.grantFilespaceAccess({ filespaceId: drive.id, email: EDITOR, role: 'editor' });
    await db.grantFilespaceAccess({ filespaceId: drive.id, email: OTHER, role: 'editor' });
    await db.grantFilespaceAccess({ filespaceId: drive.id, email: VIEWER, role: 'viewer' });
    for (const email of [EDITOR, OTHER, VIEWER, OUTSIDER]) await db.adminAddApprovedInvite({ email, name: email, reviewedBy: 'test' });
    const file = async (name, key, by) => {
      const f = await db.createFile({ name, url: `https://s3.tr.test/onyx-tr/${key}`, mime: 'video/quicktime', kind: 'video', size: 1000, storage: 's3', storageKey: key, createdBy: by });
      made.push(f.id);
      return f;
    };
    files.mine = await file('mine.mov', `${PREFIX}/Cuts/mine.mov`, EDITOR);
    files.theirs = await file('theirs.mov', `${PREFIX}/Cuts/theirs.mov`, OTHER);
    files.secret = await file('secret.mov', `${SECRET}/secret.mov`, BOSS);
    files.live = await file('live.mov', `${PREFIX}/live.mov`, EDITOR);
    // Deleted one after another, so the newest-first order is known.
    await db.softDeleteFile(files.mine.id, { deletedBy: EDITOR });
    await new Promise((r) => setTimeout(r, 5));
    await db.softDeleteFile(files.theirs.id, { deletedBy: OTHER });
    await db.softDeleteFile(files.secret.id, { deletedBy: BOSS });
  });

  after(async () => {
    for (const id of made) await db.deleteFile(id).catch(() => {});
    await db.sql`DELETE FROM file_tombstones WHERE id = ANY(${made})`.catch(() => {});
    for (const d of [drive, secretDrive]) if (d) await db.deleteFilespace(d.id).catch(() => {});
    await db.sql`DELETE FROM invite_requests WHERE email LIKE ${`%-${tag}@tr.test`}`.catch(() => {});
    await db.sql.end({ timeout: 5 }).catch(() => {});
  });

  test('an editor has the drive’s deleted files, newest first — not the live ones, not another drive’s', async () => {
    const r = await list(EDITOR);
    assert.equal(r.status, 200);
    assert.deepEqual(ours(r.body), [files.theirs.id, files.mine.id]);
    const one = r.body.files.find((f) => f.id === files.mine.id);
    assert.deepEqual(one.drive, { id: drive.id, name: drive.name });
    assert.equal(one.deletedBy, EDITOR);
  });

  test('a viewer of the drive, and someone in no drive, have none of it', async () => {
    assert.deepEqual(ours((await list(VIEWER)).body), []);
    assert.deepEqual(ours((await list(OUTSIDER)).body), []);
    const tried = await putBack(VIEWER, [files.mine.id, files.secret.id]);
    assert.equal(tried.status, 200);
    assert.deepEqual(tried.body.restored, []);
    assert.deepEqual(tried.body.notInTrash.sort(), [files.mine.id, files.secret.id].sort());
    assert.ok((await db.getFileById(files.mine.id)).deletedAt, 'still in the trash');
  });

  test('a page at a time: the cursor carries on past the last row read', async () => {
    const principal = await getPrincipal(EDITOR);
    const first = await db.listTrashForUser(principal, { limit: 1 });
    assert.deepEqual(first.files.map((f) => f.id), [files.theirs.id]);
    assert.ok(first.cursor);
    const second = await db.listTrashForUser(principal, { before: first.cursor, limit: 1 });
    assert.deepEqual(second.files.map((f) => f.id), [files.mine.id]);
  });

  test('restoreFile restores only from the trash_key it was told', async () => {
    const T = `_trash/${files.mine.id}/${files.mine.storageKey}`;
    assert.equal(await db.setTrashKeyIfUnmoved(files.mine.id, { trashKey: T, storageKey: files.mine.storageKey }), true);
    assert.equal(await db.restoreFile(files.mine.id, { trashKey: null }), null, 'decided on "not moved": missed');
    assert.ok((await db.getFileById(files.mine.id)).deletedAt);
    // Put back to "not moved" for the rest of the tests.
    await db.sql`UPDATE files SET trash_key = NULL WHERE id = ${files.mine.id}`;
  });

  test('restored: live again, renamed when told, and on its way to every device', async () => {
    const principal = await getPrincipal(EDITOR);
    const before = Number((await db.getFileById(files.theirs.id)).seq);
    const back = await putBack(EDITOR, [files.theirs.id]);
    assert.equal(back.status, 200);
    assert.deepEqual(back.body.restored, [{ id: files.theirs.id, name: 'theirs.mov', movedTo: null, restored: true }]);
    const row = await db.getFileById(files.theirs.id);
    assert.equal(row.deletedAt, null);
    assert.ok(Number(row.seq) > before);
    const feed = await db.listFileChanges({ cursor: before, principal });
    assert.ok(feed.changed.some((f) => f.id === files.theirs.id), 'the change feed has it back');

    // Back at a new key (a newer file took its old one): its transcript, made
    // of the same bytes, follows — but not on a restore that missed.
    const moved = `${PREFIX}/Cuts/mine (2).mov`;
    await db.sql`INSERT INTO transcripts (file_id, status, source_key) VALUES (${files.mine.id}, 'done', ${files.mine.storageKey})`;
    assert.equal(await db.restoreFile(files.mine.id, { trashKey: 'elsewhere', storageKey: moved, name: 'mine (2).mov' }), null);
    let [t] = await db.sql`SELECT source_key FROM transcripts WHERE file_id = ${files.mine.id}`;
    assert.equal(t.source_key, files.mine.storageKey, 'a missed restore leaves its transcript be');
    const renamed = await db.restoreFile(files.mine.id, { trashKey: null, storageKey: moved, name: 'mine (2).mov' });
    assert.equal(renamed.name, 'mine (2).mov');
    assert.equal(renamed.storageKey, moved);
    [t] = await db.sql`SELECT source_key FROM transcripts WHERE file_id = ${files.mine.id}`;
    assert.equal(t.source_key, moved, 'the transcript follows the restored bytes');
    await db.sql`DELETE FROM transcripts WHERE file_id = ${files.mine.id}`;
    assert.deepEqual(ours((await list(EDITOR)).body), []);
  });
});
