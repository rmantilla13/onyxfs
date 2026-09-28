// Review links end to end: a share link that takes comments (and, when the
// sharer asks, approvals), the guests it reaches, and what the team sees of
// them — the real route handlers against a real database. Runs with
// TEST_DATABASE_URL pointing at a throwaway database, and skips without one.
//
// Two things are replaced. '@/auth' resolves to a stub whose auth() returns
// whoever the test says is signed in (as in review-api.test.js), and
// 'next/headers' to one whose cookies() reads the jar of whichever browser
// the test says is asking — so a guest's name, a password link's unlock and
// the signed-in team are each the code that runs in production behind it.

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
process.env.ADMIN_EMAILS = 'boss@sharereview.test';
process.env.AUTH_SECRET = 'share-review-test-secret';
const skip = !live && 'TEST_DATABASE_URL not reachable';

// Registered after the alias hook, so these run first.
const AUTH = `data:text/javascript,${encodeURIComponent('export async function auth() { return globalThis.__session || null; }')}`;
const HEADERS = `data:text/javascript,${encodeURIComponent(`
  export function cookies() {
    const jar = globalThis.__jar || new Map();
    return {
      get: (name) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
      set: (name, value) => { jar.set(name, value); },
      delete: (name) => { jar.delete(name); },
    };
  }
  export function headers() { return new Headers(); }
`)}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: AUTH, shortCircuit: true };
    if (specifier === 'next/headers') return { url: HEADERS, shortCircuit: true };
    return next(specifier, context);
  },
});

const db = await import('../lib/db.js');
const { shareCookieName, shareCookieValue } = await import('../lib/shares.js');
const { GUEST_LIMIT, GUEST_LINK_LIMIT } = await import('../lib/share-review.js');
const sharesRoute = await import('../app/api/files/[id]/shares/route.js');
const shareRoute = await import('../app/api/files/[id]/shares/[token]/route.js');
const memberFeed = await import('../app/api/files/[id]/review/route.js');
const memberComments = await import('../app/api/files/[id]/comments/route.js');
const guestFeed = await import('../app/s/[token]/review/route.js');
const guestName = await import('../app/s/[token]/guest/route.js');
const guestComments = await import('../app/s/[token]/comments/route.js');
const guestComment = await import('../app/s/[token]/comments/[cid]/route.js');
const guestDecision = await import('../app/s/[token]/decision/route.js');

const tag = Math.random().toString(36).slice(2, 8);
const OWNER = `owner-${tag}@sharereview.test`;   // uploader, editor of the drive, makes the links
const VIEWER = `viewer-${tag}@sharereview.test`; // a viewer of the drive
const CONTRIB = `contrib-${tag}@sharereview.test`; // an editor of the drive whose role is Contributor
const PREFIX = `srv-${tag}`;
const DOMAIN = 'sharereview.test';
const FPS = { num: 24000, den: 1001 };

// Who is signed in, and which browser is asking: each browser its own jar.
const as = (email) => { globalThis.__session = email ? { user: { email } } : null; };
const browser = () => new Map();
const use = (jar) => { globalThis.__jar = jar; as(null); };

const req = (url, init = {}) => new Request(`http://app.test${url}`, {
  ...init,
  headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  body: init.body && typeof init.body !== 'string' ? JSON.stringify(init.body) : init.body,
});
async function call(handler, url, params, init) {
  const res = await handler(req(url, init), { params });
  const body = res.status === 304 || res.status === 204 ? null : await res.json().catch(() => null);
  // A Set-Cookie lands in the jar of the browser that asked, as it would.
  const set = res.headers.get('set-cookie');
  if (set && globalThis.__jar) {
    const m = /^([^=]+)=([^;]*)/.exec(set);
    if (m) globalThis.__jar.set(m[1], m[2]);
  }
  return { status: res.status, body, headers: res.headers };
}

// The guest routes, for link `token`.
const g = {
  feed: (token, after = 0) => call(guestFeed.GET, `/s/${token}/review?after=${after}`, { token }),
  name: (token, name) => call(guestName.POST, `/s/${token}/guest`, { token }, { method: 'POST', body: { name } }),
  post: (token, body) => call(guestComments.POST, `/s/${token}/comments`, { token }, { method: 'POST', body }),
  edit: (token, cid, body) => call(guestComment.PATCH, `/s/${token}/comments/${cid}`, { token, cid }, { method: 'PATCH', body }),
  del: (token, cid) => call(guestComment.DELETE, `/s/${token}/comments/${cid}`, { token, cid }, { method: 'DELETE' }),
  decide: (token, body) => call(guestDecision.PUT, `/s/${token}/decision`, { token }, { method: 'PUT', body }),
};
// The team's.
const m = {
  share: (file, body) => call(sharesRoute.POST, `/api/files/${file.id}/shares`, { id: file.id }, { method: 'POST', body }),
  shares: (file) => call(sharesRoute.GET, `/api/files/${file.id}/shares`, { id: file.id }),
  level: (file, token, review) => call(shareRoute.PATCH, '/x', { id: file.id, token }, { method: 'PATCH', body: { review } }),
  revoke: (file, token) => call(shareRoute.DELETE, '/x', { id: file.id, token }, { method: 'DELETE' }),
  feed: (file) => call(memberFeed.GET, `/api/files/${file.id}/review`, { id: file.id }),
  post: (file, body) => call(memberComments.POST, `/api/files/${file.id}/comments`, { id: file.id }, { method: 'POST', body }),
};

let drive;
let cut;    // a video in the drive, uploaded by OWNER
let still;  // a picture in the drive
let doc;    // a PDF in the drive: not something review handles
const made = { files: [] };
const links = {};
const jars = {};

async function unlock(jar, token) {
  const row = await db.getShareRow(token);
  jar.set(shareCookieName(token), shareCookieValue(token, row.password_hash, process.env.AUTH_SECRET));
}

before(async () => {
  if (!live) return;
  drive = await db.createFilespace({ name: `Share review ${tag}`, bucket: 'b', prefix: PREFIX, createdBy: 'boss@sharereview.test' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: OWNER, role: 'editor' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: VIEWER, role: 'viewer' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: CONTRIB, role: 'editor' });
  for (const [email, name] of [[OWNER, 'Olive Owner'], [VIEWER, 'Vic Viewer'], [CONTRIB, 'Cory Contrib']]) {
    await db.adminAddApprovedInvite({ email, name, reviewedBy: 'test' });
  }
  await db.upsertPerson(CONTRIB, { roleId: 'contributor' });
  cut = await db.createFile({
    name: 'cut.mp4', url: `http://s3.test/b/${PREFIX}/cut.mp4`, mime: 'video/mp4', kind: 'video', size: 1000,
    storage: 's3', storageKey: `${PREFIX}/cut.mp4`, createdBy: OWNER,
    metadata: { fps: FPS, frames: 2400, duration: 100.1, width: 1920, height: 1080 },
  });
  still = await db.createFile({
    name: 'still.jpg', url: `http://s3.test/b/${PREFIX}/still.jpg`, mime: 'image/jpeg', kind: 'image', size: 10,
    storage: 's3', storageKey: `${PREFIX}/still.jpg`, createdBy: OWNER,
  });
  doc = await db.createFile({
    name: 'brief.pdf', url: `http://s3.test/b/${PREFIX}/brief.pdf`, mime: 'application/pdf', kind: 'other', size: 10,
    storage: 's3', storageKey: `${PREFIX}/brief.pdf`, createdBy: OWNER,
  });
  made.files.push(cut.id, still.id, doc.id);
  for (const k of ['a', 'a2', 'b', 'still', 'nobody']) jars[k] = browser();
});

after(async () => {
  if (live) {
    for (const id of made.files) await db.deleteFile(id).catch(() => {});
    await db.sql`DELETE FROM file_tombstones WHERE id = ANY(${made.files})`.catch(() => {});
    await db.sql`DELETE FROM file_shares WHERE file_id = ANY(${made.files})`.catch(() => {});
    if (drive) await db.deleteFilespace(drive.id).catch(() => {});
    await db.sql`DELETE FROM invite_requests WHERE email LIKE ${`%-${tag}@${DOMAIN}`}`.catch(() => {});
    await db.sql`DELETE FROM people WHERE email LIKE ${`%-${tag}@${DOMAIN}`}`.catch(() => {});
    await db.sql`DELETE FROM notifications WHERE user_email LIKE ${`%-${tag}@${DOMAIN}`}`.catch(() => {});
  }
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

describe('review links', { skip }, () => {
  let jane;       // guest A's first comment
  let ownerAll;   // the team's comment for everyone
  let ownerInternal;

  test('making one: photos and videos, public or password links, and the file goes into review', async () => {
    as(OWNER);
    const view = await m.share(cut, { kind: 'public', expires: '7' });
    assert.equal(view.status, 200, JSON.stringify(view.body));
    assert.equal(view.body.share.review, null);
    links.view = view.body.share.token;
    assert.equal((await db.getFileById(cut.id)).reviewStatus, null, 'a link to look at is not a review');

    const a = await m.share(cut, { kind: 'public', review: 'comment' });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.share.review, 'comment');
    assert.equal(a.body.share.kind, 'public');
    links.a = a.body.share.token;
    assert.notEqual(links.a, links.view);
    assert.equal((await db.getFileById(cut.id)).reviewStatus, 'in_review');
    // The same request again is the same link; a view-only one is never handed back for it.
    assert.equal((await m.share(cut, { kind: 'public', review: 'comment' })).body.share.token, links.a);
    assert.notEqual((await m.share(cut, { kind: 'public' })).body.share.token, links.a);

    const b = await m.share(cut, { kind: 'password', password: 'hunter22', review: 'approve', expires: '30' });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.deepEqual([b.body.share.kind, b.body.share.review], ['password', 'approve']);
    links.b = b.body.share.token;

    const s = await m.share(still, { kind: 'public', review: 'comment' });
    links.still = s.body.share.token;

    const listed = (await m.shares(cut)).body.shares;
    assert.equal(listed.find((x) => x.token === links.b).review, 'approve');
    assert.ok(!JSON.stringify(listed).includes('hunter22'));
  });

  test('refused: a private link, a file review does not handle, a role or a drive without review links', async () => {
    as(OWNER);
    const priv = await m.share(cut, { kind: 'private', review: 'comment' });
    assert.equal(priv.status, 400);
    const pdf = await m.share(doc, { kind: 'public', review: 'comment' });
    assert.equal(pdf.status, 400);
    assert.match(pdf.body.error, /photos and videos/);

    // A Contributor makes private links, and no review ones.
    as(CONTRIB);
    const contrib = await m.share(cut, { kind: 'public', review: 'comment' });
    assert.equal(contrib.status, 403);

    // A drive that allows public links but not review links.
    await db.updateFilespace(drive.id, { shareKinds: ['public', 'password', 'private'] });
    try {
      as(OWNER);
      const r = await m.share(cut, { kind: 'public', review: 'comment', expires: '1' });
      assert.equal(r.status, 403);
      assert.match(r.body.error, /review links/);
      // Turning an existing link up is making one, and is refused the same way.
      const up = await m.level(cut, links.view, 'comment');
      assert.equal(up.status, 403);
    } finally {
      await db.updateFilespace(drive.id, { shareKinds: null });
    }
  });

  test('a link that only shows the file serves no review', async () => {
    use(jars.nobody);
    assert.equal((await g.feed(links.view)).status, 403);
    assert.equal((await g.name(links.view, 'Eve')).status, 403);
    assert.equal((await g.post(links.view, { body: 'hi' })).status, 403);
    assert.equal((await g.feed('no-such-token-here')).status, 404);
  });

  test('a guest reads at once, and gives a name to write', async () => {
    use(jars.a);
    const first = await g.feed(links.a);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.comments, []);
    assert.equal(first.body.readSeq, null, 'no name, no read marker');
    assert.equal(first.body.status, undefined, 'the file\'s status is counted over everything, so it is not a guest\'s');

    const anon = await g.post(links.a, { body: 'Too dark' });
    assert.equal(anon.status, 401);
    assert.equal(anon.body.code, 'guest');

    assert.equal((await g.name(links.a, '   ')).status, 400);
    const named = await g.name(links.a, '  Jane   Client​ ');
    assert.equal(named.status, 200);
    assert.equal(named.body.guest.name, 'Jane Client');
    const cookie = named.headers.get('set-cookie');
    assert.match(cookie, new RegExp(`^onyx_guest_${links.a}=`));
    assert.match(cookie, new RegExp(`Path=/s/${links.a}`, 'i'), 'only this link\'s path hears it');
    assert.match(cookie, /HttpOnly/i);
    jars.aId = named.body.guest.id;

    // Renaming keeps the guest: what they wrote stays theirs.
    const again = await g.name(links.a, 'Jane Client');
    assert.equal(again.body.guest.id, jars.aId);
  });

  test('a guest comments on a frame and draws — for everyone, naming nobody', async () => {
    use(jars.a);
    const r = await g.post(links.a, {
      body: 'Logo is soft here', anchor: 'frame', frameIn: 292, fps: FPS,
      annotation: { v: 1, srcW: 1920, srcH: 1080, shapes: [{ t: 'rect', c: 0, w: 3, pts: [[0.1, 0.1], [0.3, 0.2]] }] },
      // What a guest may not do is ignored, not trusted.
      audience: 'internal', mentions: [VIEWER],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    jane = r.body.comment;
    assert.equal(jane.audience, 'all');
    assert.deepEqual(jane.mentions, []);
    assert.deepEqual(jane.author, { email: null, name: 'Jane Client', guest: true, guestId: jars.aId });
    assert.equal(jane.frameIn, 292);
    assert.ok(jane.annotation);
    assert.equal(r.body.status, undefined);

    const row = (await db.sql`SELECT author_email, guest_id, share_token, audience, mentions FROM review_comments WHERE id = ${jane.id}`)[0];
    assert.deepEqual([row.author_email, row.guest_id, row.share_token, row.audience], [null, jars.aId, links.a, 'all']);
    assert.deepEqual(row.mentions, []);

    // The uploader (and the link's maker) hear of it, told it was a guest.
    const told = await db.sql`SELECT user_email, title, link FROM notifications WHERE metadata->>'commentId' = ${jane.id}`;
    const owner = told.find((n) => n.user_email === OWNER);
    assert.ok(owner, 'the uploader is told');
    assert.match(owner.title, /^Jane Client \(guest\) commented on cut\.mp4$/);
    assert.match(owner.link, new RegExp(`^/files/${cut.id}\\?c=${jane.id}`));
    assert.ok(!told.some((n) => n.user_email === VIEWER), 'a mention from a guest reaches nobody');

    // Bad input is refused as a member's would be.
    for (const body of [
      { body: 'x', anchor: 'frame', frameIn: 999999, fps: FPS },
      { body: 'x', anchor: 'point', pointX: 0.5, pointY: 0.5 },
      { body: '' },
    ]) {
      assert.equal((await g.post(links.a, body)).status, 400, JSON.stringify(body));
    }
  });

  test('the team sees the guest\'s comment, marked a guest, and the feed a guest reads names no address', async () => {
    as(VIEWER);
    const team = await m.feed(cut);
    const seen = team.body.comments.find((c) => c.id === jane.id);
    assert.deepEqual(seen.author, { email: null, name: 'Jane Client', guest: true, guestId: jars.aId });

    as(OWNER);
    ownerAll = (await m.post(cut, { body: 'Re-exporting with a sharper logo', mentions: [VIEWER] })).body.comment;
    ownerInternal = (await m.post(cut, { body: 'Client is picky, keep it simple', audience: 'internal' })).body.comment;
    assert.equal(ownerInternal.audience, 'internal');

    use(jars.a);
    const feed = await g.feed(links.a);
    const ids = feed.body.comments.map((c) => c.id);
    assert.ok(ids.includes(jane.id) && ids.includes(ownerAll.id));
    assert.ok(!ids.includes(ownerInternal.id), 'never an internal comment');
    const theirs = feed.body.comments.find((c) => c.id === ownerAll.id);
    assert.deepEqual(theirs.author, { email: null, name: 'Olive Owner', guest: false, guestId: null });
    assert.deepEqual(theirs.mentions, []);
    assert.ok(!JSON.stringify(feed.body).includes(DOMAIN), 'no address anywhere in what a guest reads');
    assert.ok(feed.body.readSeq >= 0, 'with a name comes a read marker');

    // Nor can a guest reach an internal comment by its id.
    const reply = await g.post(links.a, { body: 'Picky?', parentId: ownerInternal.id });
    assert.equal(reply.status, 400);
    assert.equal((await g.edit(links.a, ownerInternal.id, { body: 'x' })).status, 404);
  });

  test('replies go both ways, and a reply to the team is heard by them', async () => {
    use(jars.a);
    const onTheirs = await g.post(links.a, { body: 'Thanks, looks better', parentId: ownerAll.id, anchor: 'frame', frameIn: 3, fps: FPS });
    assert.equal(onTheirs.status, 201, JSON.stringify(onTheirs.body));
    assert.equal(onTheirs.body.comment.parentId, ownerAll.id);
    assert.equal(onTheirs.body.comment.anchor, 'general', 'a reply has no anchor of its own');
    jars.aReply = onTheirs.body.comment;
    const told = await db.sql`SELECT type FROM notifications WHERE user_email = ${OWNER} AND metadata->>'commentId' = ${onTheirs.body.comment.id}`;
    assert.equal(told[0]?.type, 'review.reply');

    as(OWNER);
    const back = await m.post(cut, { body: 'Will fix at 01:00:12', parentId: jane.id });
    assert.equal(back.status, 201);
    jars.ownerReply = back.body.comment;
    use(jars.a);
    const ids = (await g.feed(links.a)).body.comments.map((c) => c.id);
    assert.ok(ids.includes(jars.ownerReply.id), 'the team\'s answer in the guest\'s own thread');
  });

  test('each link is its own conversation, and a password link wants its password first', async () => {
    use(jars.b);
    assert.equal((await g.feed(links.b)).status, 401, 'no password, no review');
    assert.equal((await g.name(links.b, 'Bob')).status, 401);
    await unlock(jars.b, links.b);
    const feed = await g.feed(links.b);
    assert.equal(feed.status, 200);
    const ids = feed.body.comments.map((c) => c.id);
    assert.ok(ids.includes(ownerAll.id), 'the team\'s comments for everyone');
    assert.ok(!ids.includes(jane.id), 'not another link\'s guest');
    assert.ok(!ids.includes(jars.ownerReply.id), 'nor the team\'s reply in that guest\'s thread');
    assert.ok(!ids.includes(jars.aReply.id), 'nor that guest\'s reply on the team\'s thread');

    const named = await g.name(links.b, 'Bob Agency');
    jars.bId = named.body.guest.id;
    const bob = await g.post(links.b, { body: 'Music is too loud', anchor: 'range', frameIn: 100, frameOut: 200, fps: FPS });
    assert.equal(bob.status, 201);
    jars.bob = bob.body.comment;

    use(jars.a);
    assert.ok(!(await g.feed(links.a)).body.comments.some((c) => c.id === jars.bob.id));
    // A guest cannot reach another link's comment through their own link.
    assert.equal((await g.edit(links.a, jars.bob.id, { body: 'x' })).status, 404);
    assert.equal((await g.post(links.a, { body: 'x', parentId: jars.bob.id })).status, 400);
    // Nor use one link's name on another.
    jars.a.set(`onyx_guest_${links.b}`, jars.a.get(`onyx_guest_${links.a}`));
    await unlock(jars.a, links.b);
    assert.equal((await g.post(links.b, { body: 'x' })).status, 401);
    jars.a.delete(`onyx_guest_${links.b}`);

    as(OWNER);
    const team = (await m.feed(cut)).body.comments.map((c) => c.id);
    assert.ok([jane.id, jars.bob.id, ownerInternal.id].every((id) => team.includes(id)), 'the team sees every link');
  });

  test('a guest edits and deletes their own, and resolves nothing', async () => {
    use(jars.a2);
    await g.name(links.a, 'Jane\'s colleague');
    assert.equal((await g.edit(links.a, jane.id, { body: 'hijacked' })).status, 403, 'the same link is not the same guest');
    assert.equal((await g.del(links.a, jane.id)).status, 403);
    assert.equal((await g.edit(links.a, ownerAll.id, { body: 'hijacked' })).status, 403, 'nor the team\'s');

    use(jars.a);
    const edited = await g.edit(links.a, jane.id, { body: 'Logo is soft from here' });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.comment.body, 'Logo is soft from here');
    assert.ok(edited.body.comment.editedAt);
    assert.equal((await g.edit(links.a, jane.id, { resolved: true })).status, 403);

    const mine = await g.post(links.a, { body: 'Never mind this one' });
    const gone = await g.del(links.a, mine.body.comment.id);
    assert.equal(gone.status, 200);
    assert.equal(gone.body.comment.body, '');
    assert.equal((await g.del(links.a, mine.body.comment.id)).status, 404);

    // The team resolves a guest's thread as any other.
    as(OWNER);
    const { PATCH } = await import('../app/api/files/[id]/comments/[cid]/route.js');
    const done = await call(PATCH, '/x', { id: cut.id, cid: jane.id }, { method: 'PATCH', body: { resolved: true } });
    assert.equal(done.status, 200);
    use(jars.a);
    const seen = (await g.feed(links.a)).body.comments.find((c) => c.id === jane.id);
    assert.ok(seen.resolvedAt);
    assert.equal(seen.resolvedBy, 'owner-' + tag, 'by name, never by address');
  });

  test('approving, only where the link asks for it; each link\'s guests see only their own decisions', async () => {
    use(jars.a);
    const no = await g.decide(links.a, { status: 'approved' });
    assert.equal(no.status, 403);
    assert.match(no.body.error, /approvals/);

    use(jars.b);
    const r = await g.decide(links.b, { status: 'changes_requested', note: 'Lower the music' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.decision.name, 'Bob Agency');
    assert.equal(r.body.decision.reviewer, `guest:${jars.bId}`);
    assert.equal((await db.getFileById(cut.id)).reviewStatus, 'changes_requested', 'a guest\'s decision counts');
    const told = await db.sql`SELECT title FROM notifications WHERE user_email = ${OWNER} AND type = 'review.decision' AND metadata->>'fileId' = ${cut.id}`;
    assert.ok(told.some((n) => n.title === 'Bob Agency (guest) requested changes on cut.mp4'));

    as(VIEWER);
    const decided = await call((await import('../app/api/files/[id]/decision/route.js')).PUT, '/x', { id: cut.id }, { method: 'PUT', body: { status: 'approved' } });
    assert.equal(decided.status, 200);

    as(OWNER);
    const team = (await m.feed(cut)).body.decisions;
    const bob = team.find((d) => d.reviewer === `guest:${jars.bId}`);
    assert.deepEqual([bob.name, bob.guest, bob.email, bob.status], ['Bob Agency', true, null, 'changes_requested']);

    use(jars.b);
    const own = (await g.feed(links.b)).body.decisions;
    assert.deepEqual(own.map((d) => d.reviewer), [`guest:${jars.bId}`], 'not the team\'s decisions');
    use(jars.a);
    assert.deepEqual((await g.feed(links.a)).body.decisions, [], 'not another link\'s');

    use(jars.b);
    const back = await g.decide(links.b, { status: null });
    assert.equal(back.body.decision.status, 'withdrawn');
    assert.equal((await db.getFileById(cut.id)).reviewStatus, 'approved');
  });

  test('pins on a picture', async () => {
    use(jars.still);
    await g.name(links.still, 'Pat');
    const pin = await g.post(links.still, { body: 'Crop here', anchor: 'point', pointX: 0.25, pointY: 0.75 });
    assert.equal(pin.status, 201);
    assert.deepEqual([pin.body.comment.pointX, pin.body.comment.pointY], [0.25, 0.75]);
    assert.equal((await g.post(links.still, { body: 'x', anchor: 'frame', frameIn: 1, fps: FPS })).status, 400);
  });

  test('a link anyone may hold has a brake', async () => {
    use(jars.still);
    const id = (await g.name(links.still, 'Pat')).body.guest.id;
    const insert = (n, guestId) => db.sql`
      INSERT INTO review_comments (id, file_id, author_name, guest_id, body, anchor, audience, share_token, created_at, updated_at)
      SELECT 'flood-' || ${tag} || '-' || ${guestId || 'x'} || '-' || i, ${still.id}, 'Flood', ${guestId}, 'x', 'general', 'all', ${links.still},
             ${Date.now()}, ${Date.now()}
      FROM generate_series(1, ${n}) AS i`;
    try {
      await insert(GUEST_LIMIT, id);
      const mine = await g.post(links.still, { body: 'one more' });
      assert.equal(mine.status, 429);
      assert.match(mine.body.error, /You have posted/);
      await db.sql`DELETE FROM review_comments WHERE id LIKE ${`flood-${tag}-%`}`;
      await insert(GUEST_LINK_LIMIT, null);
      const link = await g.post(links.still, { body: 'one more' });
      assert.equal(link.status, 429);
      assert.match(link.body.error, /This link/);
    } finally {
      await db.sql`DELETE FROM review_comments WHERE id LIKE ${`flood-${tag}-%`}`;
    }
    assert.equal((await g.post(links.still, { body: 'one more' })).status, 201);
  });

  test('a link\'s level changes in place: down by whoever may revoke it, up only as making one', async () => {
    as(VIEWER);
    assert.equal((await m.level(cut, links.a, 'view')).status, 403, 'a viewer of the file may not');

    as(OWNER);
    const down = await m.level(cut, links.b, 'comment');
    assert.equal(down.status, 200, JSON.stringify(down.body));
    assert.equal(down.body.share.review, 'comment');
    use(jars.b);
    assert.equal((await g.decide(links.b, { status: 'approved' })).status, 403, 'no approvals from here now');

    as(OWNER);
    assert.equal((await m.level(cut, links.a, 'view')).body.share.review, null);
    use(jars.a);
    const closed = await g.feed(links.a);
    assert.equal(closed.status, 403);
    assert.match(closed.body.error, /does not take comments/);
    as(OWNER);
    assert.ok((await m.feed(cut)).body.comments.some((c) => c.id === jane.id), 'what was written stays on the file');

    as(CONTRIB);
    assert.equal((await m.level(cut, links.a, 'comment')).status, 403, 'a role without review links cannot turn one up');
    as(OWNER);
    assert.equal((await m.level(cut, links.a, 'comment')).status, 200);
    use(jars.a);
    assert.equal((await g.feed(links.a)).status, 200);

    as(OWNER);
    const priv = await m.share(cut, { kind: 'private' });
    assert.equal((await m.level(cut, priv.body.share.token, 'comment')).status, 400, 'never a private link');
  });

  test('the review flag is read on the server: off, a review link is only a link', async () => {
    const saved = await db.getFeatureFlags({ fresh: true });
    await db.setFeatureFlags({ ...saved, review: false }, 'test');
    try {
      use(jars.a);
      const r = await g.feed(links.a);
      assert.equal(r.status, 403);
      assert.equal((await g.post(links.a, { body: 'x' })).status, 403);
    } finally {
      await db.setFeatureFlags(saved, 'test');
    }
  });

  test('revoking the link ends its review; what was written stays with the file', async () => {
    as(OWNER);
    assert.equal((await m.revoke(cut, links.a)).status, 200);
    use(jars.a);
    assert.equal((await g.feed(links.a)).status, 404);
    assert.equal((await g.post(links.a, { body: 'still here?' })).status, 404);
    as(OWNER);
    const team = (await m.feed(cut)).body.comments.map((c) => c.id);
    assert.ok(team.includes(jane.id));
  });
});
