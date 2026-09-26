// The review API end to end: the real route handlers, against a real
// database, with only the session stubbed. Runs with TEST_DATABASE_URL
// pointing at a throwaway database, and skips without one.
//
// The session is the one thing replaced: '@/auth' resolves to a stub whose
// auth() returns whoever the test says is signed in. Everything behind it —
// buildPrincipal, the drive boundary, canAccessFile, the flag as the person
// has it — is the code that runs in production.

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
process.env.DATABASE_URL = live ? URL_ : 'postgres://onyx:onyx@127.0.0.1:1/onyx';
process.env.ADMIN_EMAILS = 'boss@review.test';
const skip = !live && 'TEST_DATABASE_URL not reachable';

// Registered after the alias hook, so it runs first: '@/auth' is the stub.
const STUB = `data:text/javascript,${encodeURIComponent('export async function auth() { return globalThis.__reviewSession || null; }')}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: STUB, shortCircuit: true };
    return next(specifier, context);
  },
});
const as = (email) => { globalThis.__reviewSession = email ? { user: { email } } : null; };

const db = await import('../lib/db.js');
const feedRoute = await import('../app/api/files/[id]/review/route.js');
const commentsRoute = await import('../app/api/files/[id]/comments/route.js');
const commentRoute = await import('../app/api/files/[id]/comments/[cid]/route.js');
const decisionRoute = await import('../app/api/files/[id]/decision/route.js');
const mentionRoute = await import('../app/api/files/[id]/mentionable/route.js');
const probeRoute = await import('../app/api/files/[id]/probe/route.js');
const fileRoute = await import('../app/api/files/[id]/route.js');

const tag = Math.random().toString(36).slice(2, 8);
const OWNER = `owner-${tag}@review.test`;     // uploader, and an editor of the drive
const MEMBER = `member-${tag}@review.test`;   // a viewer of the drive
const OUTSIDER = `out-${tag}@review.test`;    // signed in, in no drive
const BANNED = `banned-${tag}@review.test`;   // signed in once, since banned: an account, no access
const STRANGER = `stranger-${tag}@external.example`; // never an account at all
const BOSS = 'boss@review.test';               // an admin (ADMIN_EMAILS), with no invite of their own
const PREFIX = `drv-${tag}`;
const FPS = { num: 24000, den: 1001 };

const req = (url, init = {}) => new Request(`http://app.test${url}`, {
  ...init,
  headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  body: init.body && typeof init.body !== 'string' ? JSON.stringify(init.body) : init.body,
});
async function call(handler, url, params, init) {
  const res = await handler(req(url, init), { params });
  const body = res.status === 304 || res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body, headers: res.headers };
}

let drive;
let cut;       // a video in the drive, uploaded by OWNER
let still;     // an org-visible image in the library
const made = { files: [], notifications: [] };

before(async () => {
  if (!live) return;
  drive = await db.createFilespace({ name: `Review ${tag}`, bucket: 'b', prefix: PREFIX, createdBy: 'boss@review.test' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: OWNER, role: 'editor' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: MEMBER, role: 'viewer' });
  for (const [email, name] of [[OWNER, 'Olive Owner'], [MEMBER, 'Mo Member'], [OUTSIDER, 'Otto Outsider'], [BANNED, 'Bea Banned']]) {
    await db.adminAddApprovedInvite({ email, name, reviewedBy: 'test' });
  }
  // Bea signed in (so has a "user" row), then was banned: the row outlives
  // the invite. The admin has a row and no invite, and needs none.
  for (const email of [BANNED, BOSS]) await db.getOrCreateAuthUser(email);
  await db.sql`UPDATE "user" SET name = 'Bea Banned' WHERE email = ${BANNED}`;
  await db.sql`UPDATE "user" SET name = ${`Boss ${tag}`} WHERE email = ${BOSS}`;
  const [invite] = await db.sql`SELECT id FROM invite_requests WHERE email = ${BANNED}`;
  await db.updateInviteRequest(invite.id, { status: 'banned', reviewedBy: 'test' });
  cut = await db.createFile({
    name: 'cut.mp4', url: `http://s3.test/b/${PREFIX}/cut.mp4`, mime: 'video/mp4', kind: 'video', size: 1000,
    storage: 's3', storageKey: `${PREFIX}/cut.mp4`, createdBy: OWNER,
    metadata: { fps: FPS, frames: 2400, tcStart: 86400, dropFrame: false, duration: 100.1 },
  });
  still = await db.createFile({
    name: 'still.jpg', url: 'http://s3.test/b/files/still.jpg', mime: 'image/jpeg', kind: 'image', size: 10,
    storage: 's3', storageKey: `files/still-${tag}.jpg`, createdBy: OWNER,
  });
  made.files.push(cut.id, still.id);
});

after(async () => {
  if (live) {
    for (const id of made.files) await db.deleteFile(id).catch(() => {});
    await db.sql`DELETE FROM file_tombstones WHERE id = ANY(${made.files})`.catch(() => {});
    if (drive) await db.deleteFilespace(drive.id).catch(() => {});
    await db.sql`DELETE FROM invite_requests WHERE email LIKE ${`%-${tag}@review.test`}`.catch(() => {});
    await db.sql`DELETE FROM notifications WHERE user_email LIKE ${`%-${tag}@review.test`}`.catch(() => {});
    await db.sql`DELETE FROM "user" WHERE email = ANY(${[BANNED, BOSS]})`.catch(() => {});
  }
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

describe('the review API', { skip }, () => {
  let first;

  test('someone outside the drive cannot read its review; a member can', async () => {
    as(OUTSIDER);
    const out = await call(feedRoute.GET, `/api/files/${cut.id}/review`, { id: cut.id });
    assert.equal(out.status, 403);
    as(null);
    assert.equal((await call(feedRoute.GET, `/api/files/${cut.id}/review`, { id: cut.id })).status, 401);
    as(MEMBER);
    const mine = await call(feedRoute.GET, `/api/files/${cut.id}/review`, { id: cut.id });
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body.comments, []);
    assert.equal(mine.body.status, null);
    assert.equal(mine.body.readSeq, 0);
  });

  test('a viewer of the drive comments on a frame; the file goes into review', async () => {
    as(MEMBER);
    const r = await call(commentsRoute.POST, `/api/files/${cut.id}/comments`, { id: cut.id }, {
      method: 'POST',
      body: {
        body: 'Logo is soft here', anchor: 'frame', frameIn: 292, fps: FPS,
        annotation: { v: 1, srcW: 1920, srcH: 1080, shapes: [{ t: 'rect', c: 0, w: 3, pts: [[0.1, 0.1], [0.3, 0.2]] }] },
        mentions: [OWNER, OUTSIDER],
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    first = r.body.comment;
    assert.equal(first.frameIn, 292);
    assert.deepEqual(first.fps, FPS);
    assert.equal(first.author.email, MEMBER);
    assert.equal(first.author.name, 'Mo Member');
    // The outsider cannot read the file, so cannot be mentioned on it.
    assert.deepEqual(first.mentions, [OWNER]);
    assert.equal(r.body.status, 'in_review');
    assert.equal(r.body.openComments, 1);
    const row = await db.getFileById(cut.id);
    assert.equal(row.reviewStatus, 'in_review');
    assert.equal(row.openComments, 1);
    assert.equal(row.version, cut.version, 'a comment is not an edit of the file');
    assert.equal(row.seq, cut.seq, 'nor something a syncing device hears about');
  });

  test('the mention and the uploader are told; the outsider is not', async () => {
    const rows = await db.sql`SELECT user_email, type, link FROM notifications WHERE metadata->>'commentId' = ${first.id}`;
    const byEmail = Object.fromEntries(rows.map((n) => [n.user_email, n]));
    assert.equal(byEmail[OWNER]?.type, 'review.mention');
    assert.equal(byEmail[OUTSIDER], undefined);
    assert.equal(byEmail[MEMBER], undefined, 'never the author');
    assert.match(byEmail[OWNER].link, new RegExp(`^/files/${cut.id}\\?c=${first.id}&t=01%3A00%3A12%3A04$`));
  });

  test('the feed pages by cursor, and an unchanged feed is a 304', async () => {
    as(OWNER);
    const all = await call(feedRoute.GET, `/api/files/${cut.id}/review`, { id: cut.id });
    assert.equal(all.status, 200);
    assert.equal(all.body.comments.length, 1);
    assert.equal(all.body.cursor, first.seq);
    assert.match(all.headers.get('etag'), new RegExp(`${cut.id}\\.${first.seq}`));
    const again = await call(feedRoute.GET, `/api/files/${cut.id}/review?after=${all.body.cursor}`, { id: cut.id });
    assert.equal(again.status, 304);
    // Reading moved the owner's marker: next first load says so.
    const reload = await call(feedRoute.GET, `/api/files/${cut.id}/review`, { id: cut.id });
    assert.equal(reload.body.readSeq, first.seq);
  });

  test('a reply joins the thread at its top, and only the author edits', async () => {
    as(OWNER);
    const reply = await call(commentsRoute.POST, `/api/files/${cut.id}/comments`, { id: cut.id }, {
      method: 'POST', body: { body: 'Re-exporting now', parentId: first.id, anchor: 'frame', frameIn: 9, fps: FPS },
    });
    assert.equal(reply.status, 201);
    assert.equal(reply.body.comment.parentId, first.id);
    assert.equal(reply.body.comment.anchor, 'general', 'a reply has no anchor of its own');
    const nested = await call(commentsRoute.POST, `/api/files/${cut.id}/comments`, { id: cut.id }, {
      method: 'POST', body: { body: 'nested', parentId: reply.body.comment.id },
    });
    assert.equal(nested.body.comment.parentId, first.id, 'threads are one level deep');
    assert.equal(nested.body.openComments, 1, 'replies are not open threads');
    const told = await db.sql`SELECT type FROM notifications WHERE user_email = ${MEMBER} AND metadata->>'commentId' = ${reply.body.comment.id}`;
    assert.equal(told[0]?.type, 'review.reply');

    const theirs = await call(commentRoute.PATCH, '/x', { id: cut.id, cid: first.id }, { method: 'PATCH', body: { body: 'hijacked' } });
    assert.equal(theirs.status, 403);
    const own = await call(commentRoute.PATCH, '/x', { id: cut.id, cid: reply.body.comment.id }, { method: 'PATCH', body: { body: 'Re-exported' } });
    assert.equal(own.status, 200);
    assert.equal(own.body.comment.body, 'Re-exported');
    assert.ok(own.body.comment.editedAt);
    assert.ok(own.body.comment.seq > reply.body.comment.seq, 'an edit re-stamps the row, so feeds see it');
  });

  test('resolving: the author or an editor of the file, and only a thread', async () => {
    as(OUTSIDER);
    assert.equal((await call(commentRoute.PATCH, '/x', { id: cut.id, cid: first.id }, { method: 'PATCH', body: { resolved: true } })).status, 403);
    as(OWNER); // an editor of the drive, not the author
    const done = await call(commentRoute.PATCH, '/x', { id: cut.id, cid: first.id }, { method: 'PATCH', body: { resolved: true } });
    assert.equal(done.status, 200);
    assert.ok(done.body.comment.resolvedAt);
    assert.equal(done.body.comment.resolvedBy, OWNER);
    assert.equal(done.body.openComments, 0);
    assert.equal(done.body.status, 'in_review');
    const reopened = await call(commentRoute.PATCH, '/x', { id: cut.id, cid: first.id }, { method: 'PATCH', body: { resolved: false } });
    assert.equal(reopened.body.openComments, 1);
  });

  test('decisions: approve, a request for changes outweighs it, and withdrawing reaches the feed', async () => {
    as(OWNER);
    const before = (await call(feedRoute.GET, `/api/files/${cut.id}/review`, { id: cut.id })).body.cursor;
    as(MEMBER);
    const yes = await call(decisionRoute.PUT, '/x', { id: cut.id }, { method: 'PUT', body: { status: 'approved' } });
    assert.equal(yes.status, 200);
    assert.equal(yes.body.status, 'approved');
    as(OWNER);
    const no = await call(decisionRoute.PUT, '/x', { id: cut.id }, { method: 'PUT', body: { status: 'changes_requested', note: 'Fix the logo' } });
    assert.equal(no.body.status, 'changes_requested');
    assert.equal((await db.getFileById(cut.id)).reviewStatus, 'changes_requested');
    const back = await call(decisionRoute.PUT, '/x', { id: cut.id }, { method: 'PUT', body: { status: null } });
    assert.equal(back.body.status, 'approved');
    assert.equal(back.body.decision.status, 'withdrawn');

    const delta = await call(feedRoute.GET, `/api/files/${cut.id}/review?after=${before}`, { id: cut.id });
    const mine = delta.body.decisions.find((d) => d.email === OWNER);
    assert.equal(mine.status, 'withdrawn', 'a withdrawn decision moves the cursor, so open panels drop it');
    assert.equal(delta.body.decisions.find((d) => d.email === MEMBER).name, 'Mo Member');
    assert.equal((await call(decisionRoute.PUT, '/x', { id: cut.id }, { method: 'PUT', body: { status: 'maybe' } })).status, 400);
  });

  test('bad input is a 400, not a stored row', async () => {
    as(MEMBER);
    const cases = [
      { body: 'x', anchor: 'frame', frameIn: 999999, fps: FPS },                     // past the end
      { body: 'x', anchor: 'point', pointX: 0.5, pointY: 0.5 },                     // a pin on a video
      { body: '', annotation: { v: 1, srcW: 10, srcH: 10, shapes: [{ t: 'pen', c: 0, w: 2, pts: [[2, 2]] }] } },
      { body: 'x', parentId: 'no-such-comment' },
    ];
    for (const body of cases) {
      const r = await call(commentsRoute.POST, '/x', { id: cut.id }, { method: 'POST', body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    const img = await call(commentsRoute.POST, '/x', { id: still.id }, { method: 'POST', body: { body: 'x', anchor: 'frame', frameIn: 1, fps: FPS } });
    assert.equal(img.status, 400);
    const pin = await call(commentsRoute.POST, '/x', { id: still.id }, { method: 'POST', body: { body: 'crop here', anchor: 'point', pointX: 0.25, pointY: 0.75 } });
    assert.equal(pin.status, 201);
    assert.deepEqual([pin.body.comment.pointX, pin.body.comment.pointY], [0.25, 0.75]);
  });

  test('@mentions suggest only people who can read the file', async () => {
    as(OWNER);
    const inDrive = await call(mentionRoute.GET, `/api/files/${cut.id}/mentionable?q=${tag}`, { id: cut.id });
    assert.equal(inDrive.status, 200);
    const emails = inDrive.body.people.map((p) => p.email);
    assert.ok(emails.includes(MEMBER));
    assert.ok(!emails.includes(OUTSIDER), 'not a member of the drive');
    assert.ok(!emails.includes(OWNER), 'not the asker');
    // An org-visible library file: anyone let in.
    const lib = await call(mentionRoute.GET, `/api/files/${still.id}/mentionable?q=${tag}`, { id: still.id });
    assert.ok(lib.body.people.some((p) => p.email === OUTSIDER && p.name === 'Otto Outsider'));
    as(OUTSIDER);
    assert.equal((await call(mentionRoute.GET, `/x?q=`, { id: cut.id })).status, 403);
  });

  test('a mention names only someone who may sign in, even on a file the whole org can read', async () => {
    // canAccessFile says yes to ANY address for an org-visible file outside
    // every drive, so the sign-in gate is what stops these two.
    as(MEMBER);
    const r = await call(commentsRoute.POST, '/x', { id: still.id }, {
      method: 'POST', body: { body: `hey @stranger @bea @otto`, mentions: [STRANGER, BANNED, OUTSIDER] },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.comment.mentions, [OUTSIDER]);
    const watching = (await db.sql`SELECT email FROM review_watchers WHERE file_id = ${still.id}`).map((w) => w.email);
    assert.ok(watching.includes(OUTSIDER));
    assert.ok(!watching.includes(STRANGER), 'an address that is not an account follows nothing');
    assert.ok(!watching.includes(BANNED), 'nor does someone who was banned');
    const told = (await db.sql`SELECT user_email FROM notifications WHERE metadata->>'commentId' = ${r.body.comment.id}`).map((n) => n.user_email);
    assert.ok(told.includes(OUTSIDER));
    assert.ok(!told.includes(STRANGER) && !told.includes(BANNED));

    // Editing the words is held to the same rule.
    const edited = await call(commentRoute.PATCH, '/x', { id: still.id, cid: r.body.comment.id }, {
      method: 'PATCH', body: { body: 'hey @stranger @bea', mentions: [STRANGER, BANNED] },
    });
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.body.comment.mentions, []);
  });

  test('a watcher who has since been banned is not told', async () => {
    await db.addReviewWatchers(still.id, [BANNED]);
    as(OWNER);
    const r = await call(commentsRoute.POST, '/x', { id: still.id }, { method: 'POST', body: { body: 'New export is up' } });
    assert.equal(r.status, 201);
    const told = (await db.sql`SELECT user_email FROM notifications WHERE metadata->>'commentId' = ${r.body.comment.id}`).map((n) => n.user_email);
    assert.ok(told.includes(MEMBER), 'a commenter who may still sign in hears of it');
    assert.ok(!told.includes(BANNED));
  });

  test('suggestions are people who are active: not a banned account, but an admin without an invite', async () => {
    as(OWNER);
    const lib = await call(mentionRoute.GET, `/x?q=${tag}`, { id: still.id });
    const emails = lib.body.people.map((p) => p.email);
    assert.ok(emails.includes(OUTSIDER));
    assert.ok(!emails.includes(BANNED), 'a "user" row outlives the ban; it does not make its owner mentionable');
    const boss = await call(mentionRoute.GET, `/x?q=${encodeURIComponent(`boss ${tag}`)}`, { id: still.id });
    assert.deepEqual(boss.body.people, [{ email: BOSS, name: `Boss ${tag}` }]);
    // Left out of the pool itself, not only filtered after: the route checks
    // a handful of candidates, and a banned one would take a place.
    const pool = (await db.listMentionCandidates({ q: tag })).map((p) => p.email);
    assert.ok(pool.includes(MEMBER) && !pool.includes(BANNED));
  });

  test('deleting a comment keeps its place and drops its words; only the author or an editor', async () => {
    as(OUTSIDER);
    assert.equal((await call(commentRoute.DELETE, '/x', { id: cut.id, cid: first.id }, { method: 'DELETE' })).status, 403);
    as(MEMBER);
    const gone = await call(commentRoute.DELETE, '/x', { id: cut.id, cid: first.id }, { method: 'DELETE' });
    assert.equal(gone.status, 200);
    assert.equal(gone.body.comment.body, '');
    assert.equal(gone.body.comment.annotation, null);
    assert.ok(gone.body.comment.deletedAt);
    assert.equal(gone.body.openComments, 0);
    assert.equal((await call(commentRoute.PATCH, '/x', { id: cut.id, cid: first.id }, { method: 'PATCH', body: { body: 'back' } })).status, 404);
  });

  test('the feed pages: a full page stops at its last comment, and a decision after it waits for the next', async () => {
    const f = await db.createFile({
      name: 'pages.jpg', url: 'http://s3.test/b/files/pages.jpg', mime: 'image/jpeg', kind: 'image', storage: 's3',
      storageKey: `files/pages-${tag}.jpg`, createdBy: OWNER,
    });
    made.files.push(f.id);
    const post = async (body) => {
      as(OWNER);
      const r = await call(commentsRoute.POST, '/x', { id: f.id }, { method: 'POST', body: { body } });
      assert.equal(r.status, 201);
      return r.body.comment;
    };
    const decide = async (who, status) => {
      as(who);
      const r = await call(decisionRoute.PUT, '/x', { id: f.id }, { method: 'PUT', body: { status } });
      assert.equal(r.status, 200);
      return r.body.decision;
    };
    // In seq order: c1 c2 [early decision] c3 [late decision] c4.
    const c1 = await post('one');
    const c2 = await post('two');
    const early = await decide(MEMBER, 'approved');
    const c3 = await post('three');
    const late = await decide(OUTSIDER, 'changes_requested');
    const c4 = await post('four');
    assert.ok(early.seq > c2.seq && early.seq < c3.seq && late.seq > c3.seq && late.seq < c4.seq);

    const p1 = await db.listReviewFeed(f.id, { limit: 3 });
    assert.deepEqual(p1.comments.map((c) => c.id), [c1.id, c2.id, c3.id]);
    assert.equal(p1.more, true);
    assert.equal(p1.cursor, c3.seq, 'the cursor claims only what was delivered');
    assert.deepEqual(p1.decisions.map((d) => d.email), [MEMBER], 'the late decision is past the cursor, so it waits');

    const p2 = await db.listReviewFeed(f.id, { after: p1.cursor, limit: 3 });
    assert.deepEqual(p2.comments.map((c) => c.id), [c4.id]);
    assert.equal(p2.more, false);
    assert.deepEqual(p2.decisions.map((d) => d.email), [OUTSIDER]);
    assert.equal(p2.cursor, c4.seq);

    const p3 = await db.listReviewFeed(f.id, { after: p2.cursor, limit: 3 });
    assert.deepEqual([p3.comments, p3.decisions, p3.more, p3.cursor], [[], [], false, p2.cursor]);

    // The route hands the flag on, and pages no larger than REVIEW_FEED_LIMIT.
    as(OWNER);
    const whole = await call(feedRoute.GET, '/x', { id: f.id });
    assert.equal(whole.body.more, false);
    assert.equal(whole.body.comments.length, 4);
    assert.equal(db.REVIEW_FEED_LIMIT, 500);
    assert.equal((await db.listReviewFeed(f.id, { limit: 10_000 })).comments.length, 4);
  });

  test('writers that race leave the row behind; the next read of the feed puts it right', async () => {
    const f = await db.createFile({
      name: 'race.jpg', url: 'http://s3.test/b/files/race.jpg', mime: 'image/jpeg', kind: 'image', storage: 's3',
      storageKey: `files/race-${tag}.jpg`, createdBy: OWNER,
    });
    made.files.push(f.id);
    as(OWNER);
    // Each write counts, then stores, what it counted; concurrent ones can
    // store a count taken before another's row committed.
    const posted = await Promise.all(Array.from({ length: 6 }, (_, i) => call(commentsRoute.POST, '/x', { id: f.id }, { method: 'POST', body: { body: `note ${i}` } })));
    assert.ok(posted.every((r) => r.status === 201));
    await Promise.all(posted.slice(0, 2).map((r) => call(commentRoute.PATCH, '/x', { id: f.id, cid: r.body.comment.id }, { method: 'PATCH', body: { resolved: true } })));
    // Whatever the interleaving left, make it certainly wrong.
    await db.sql`UPDATE files SET review_status = 'approved', open_comments = 99 WHERE id = ${f.id}`;

    as(MEMBER);
    const r = await call(feedRoute.GET, '/x', { id: f.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.openComments, 4, 'counted from the comments, not read off the row');
    assert.equal(r.body.status, 'in_review');
    const row = await db.getFileById(f.id);
    assert.equal(row.openComments, 4);
    assert.equal(row.reviewStatus, 'in_review');
    // And the repair is itself not an edit a device would hear of.
    assert.equal(row.version, f.version);
    assert.equal(row.seq, f.seq);
  });

  test('the review flag is read on the server', async () => {
    const saved = await db.getFeatureFlags({ fresh: true });
    await db.setFeatureFlags({ ...saved, review: false }, 'test');
    try {
      as(OWNER);
      const r = await call(feedRoute.GET, `/api/files/${cut.id}/review`, { id: cut.id });
      assert.equal(r.status, 403);
      assert.match(r.body.error, /turned off/);
    } finally {
      await db.setFeatureFlags(saved, 'test');
    }
  });

  test('the frame backfill is for editors, and for videos', async () => {
    as(MEMBER);
    assert.equal((await call(probeRoute.POST, '/x', { id: cut.id }, { method: 'POST' })).status, 403);
    as(OWNER);
    assert.equal((await call(probeRoute.POST, '/x', { id: still.id }, { method: 'POST' })).status, 400);
    // Already probed: answered from the row, with no read of the object.
    const known = await call(probeRoute.POST, '/x', { id: cut.id }, { method: 'POST' });
    assert.equal(known.status, 200);
    assert.deepEqual(known.body.metadata.fps, FPS);
    assert.equal(known.body.probed, false);
  });

  test('the backfill never fetches an address a client recorded', async () => {
    // A Blob row's url is whatever the uploader sent. Reading it would let
    // anyone who can add a file point the server at any address at all.
    const planted = await db.createFile({
      name: 'planted.mp4', url: 'http://169.254.169.254/latest/meta-data/', kind: 'video', mime: 'video/mp4',
      storage: 'blob', createdBy: OWNER,
    });
    made.files.push(planted.id);
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (...args) => { calls.push(String(args[0])); return real(...args); };
    try {
      as(OWNER);
      const r = await call(probeRoute.POST, '/x', { id: planted.id }, { method: 'POST' });
      assert.equal(r.status, 400);
    } finally {
      globalThis.fetch = real;
    }
    assert.deepEqual(calls, [], 'nothing was fetched');
  });

  test('a trashed file has no review, and no detail', async () => {
    const trash = await db.createFile({
      name: 'old.mp4', url: 'http://s3.test/b/files/old.mp4', kind: 'video', storage: 's3',
      storageKey: `files/old-${tag}.mp4`, createdBy: OWNER,
    });
    made.files.push(trash.id);
    await db.softDeleteFile(trash.id);
    as(OWNER);
    assert.equal((await call(feedRoute.GET, '/x', { id: trash.id })).status, 404);
    assert.equal((await call(commentsRoute.POST, '/x', { id: trash.id }, { method: 'POST', body: { body: 'x' } })).status, 404);
    assert.equal((await call(fileRoute.GET, '/x', { id: trash.id })).status, 404);
  });

  test('deleting a file removes its review rows', async () => {
    const f = await db.createFile({
      name: 'gone.jpg', url: 'http://s3.test/b/files/gone.jpg', kind: 'image', storage: 's3',
      storageKey: `files/gone-${tag}.jpg`, createdBy: OWNER,
    });
    as(OWNER);
    await call(commentsRoute.POST, '/x', { id: f.id }, { method: 'POST', body: { body: 'soon gone' } });
    await call(decisionRoute.PUT, '/x', { id: f.id }, { method: 'PUT', body: { status: 'approved' } });
    await call(feedRoute.GET, '/x', { id: f.id });
    const count = async () => (await db.sql`
      SELECT (SELECT count(*) FROM review_comments WHERE file_id = ${f.id})
           + (SELECT count(*) FROM review_decisions WHERE file_id = ${f.id})
           + (SELECT count(*) FROM review_watchers WHERE file_id = ${f.id})
           + (SELECT count(*) FROM review_reads WHERE file_id = ${f.id}) AS n`)[0].n;
    assert.ok(Number(await count()) >= 4);
    await db.deleteFile(f.id);
    assert.equal(Number(await count()), 0);
    await db.sql`DELETE FROM file_tombstones WHERE id = ${f.id}`;
  });
});
