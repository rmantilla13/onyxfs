// Proxy renditions end to end: the real route handlers against a real
// database, with only the session stubbed ('@/auth' → whoever the test says).
// Runs with TEST_DATABASE_URL pointing at a throwaway database, and skips
// without one.
//
// No bucket is needed and none is contacted: presigning is local arithmetic
// over the stored credentials, so the URLs the claim hands out can be checked
// for what they are FOR — the master to read, the proxy key to write — without
// an S3 anywhere.
//
// What only a database can show: that the claim is atomic, that it names the
// object's key itself and records it, that the claimer-only writes really are,
// that a lapsed lease comes back, that the queue holds to the drive boundary
// and the write rule, and that a purge takes the row.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const URL_ = process.env.TEST_DATABASE_URL;
async function reachable(url) {
  if (!url) return false;
  const { default: postgres } = await import('postgres');
  const probe = postgres(url, { max: 1, connect_timeout: 3, idle_timeout: 1 });
  try { await probe`SELECT 1`; return true; } catch { return false; } finally { await probe.end({ timeout: 2 }).catch(() => {}); }
}
const live = await reachable(URL_);
process.env.DATABASE_URL = live ? URL_ : 'postgres://onyx:onyx@127.0.0.1:1/onyx';
process.env.ADMIN_EMAILS = 'boss@px.test';
const skip = !live && 'TEST_DATABASE_URL not reachable';

// A request's session: the one it was started under (so two can run at once,
// as two Macs), else whoever the test last signed in.
globalThis.__pxAls = new AsyncLocalStorage();
const STUB = `data:text/javascript,${encodeURIComponent('export async function auth() { return globalThis.__pxAls.getStore() || globalThis.__pxSession || null; }')}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: STUB, shortCircuit: true };
    return next(specifier, context);
  },
});
const as = (email) => { globalThis.__pxSession = email ? { user: { email } } : null; };
const asFor = (email, fn) => globalThis.__pxAls.run({ user: { email } }, fn);

const db = await import('../lib/db.js');
const route = await import('../app/api/files/[id]/proxy/route.js');
const claimRoute = await import('../app/api/files/[id]/proxy/claim/route.js');
const queueRoute = await import('../app/api/proxies/queue/route.js');
const { isProxyKey } = await import('../lib/media.js');
const { PROXY_MAX_HEIGHT, PROXY_MAX_PUT_BYTES } = await import('../lib/proxies.js');

const tag = Math.random().toString(36).slice(2, 8);
const OWNER = `owner-${tag}@px.test`;    // uploader, an editor of the drive
const OTHER = `other-${tag}@px.test`;    // another editor of the drive, with a Mac
const VIEWER = `viewer-${tag}@px.test`;  // a Member, and a viewer of the drive
const OUTSIDER = `out-${tag}@px.test`;   // a Member in no drive
const BOSS = 'boss@px.test';             // an admin
const PREFIX = `px-${tag}`;
const SECRET = `pxs-${tag}`;

// Credentials, not a bucket: presigning never opens a socket.
const STORAGE = {
  provider: 's3', bucket: 'onyx-px', region: 'us-east-1', endpoint: 'https://s3.px.test',
  accessKeyId: 'AKIAPXTEST', secretAccessKey: 'px-secret', prefix: 'files',
};

async function call(handler, id, method, body) {
  const res = await handler(new Request(`http://app.test/api/files/${id}/proxy`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }), { params: { id } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const queue = async (query = '') => {
  const res = await queueRoute.GET(new Request(`http://app.test/api/proxies/queue${query}`));
  return { status: res.status, body: await res.json().catch(() => null) };
};
const ids = (q) => q.body.jobs.map((j) => j.fileId);
// The jobs someone asked for. After them the queue offers large videos with no
// job at all (listProxyJobs), which another test file's rows can add to in a
// shared database — so the exact lists below are of what was asked for.
const asked = (q) => q.body.jobs.filter((j) => j.requestedAt).map((j) => j.fileId);

let drive; let secretDrive; let priorStorage;
let cut; let mine; let theirs; let secret; let binned; let pic;
const made = [];

before(async () => {
  if (!live) return;
  await db.ensureSchema();
  priorStorage = await db.getSetting('storage.config');
  await db.setSetting('storage.config', STORAGE, 'test');
  drive = await db.createFilespace({ name: `Px ${tag}`, bucket: 'onyx-px', prefix: PREFIX, createdBy: BOSS });
  secretDrive = await db.createFilespace({ name: `Pxs ${tag}`, bucket: 'onyx-px', prefix: SECRET, createdBy: BOSS });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: OWNER, role: 'editor' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: OTHER, role: 'editor' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: VIEWER, role: 'viewer' });
  for (const email of [OWNER, OTHER, VIEWER, OUTSIDER]) await db.adminAddApprovedInvite({ email, name: email, reviewedBy: 'test' });
  const video = (name, key, by, extra = {}) => db.createFile({
    name, url: `https://s3.px.test/onyx-px/${key}`, mime: 'video/quicktime', kind: 'video',
    size: 4_000_000_000, storage: 's3', storageKey: key, createdBy: by,
    metadata: { width: 3840, height: 2160 }, ...extra,
  });
  cut = await video('cut.mov', `${PREFIX}/cut.mov`, OWNER, { contentHash: 'etag-cut' });
  mine = await video('mine.mov', `files/mine-${tag}.mov`, OWNER);        // the library, org-visible, OWNER's
  theirs = await video('theirs.mov', `files/theirs-${tag}.mov`, BOSS);   // the library, org-visible, not OWNER's
  secret = await video('secret.mov', `${SECRET}/secret.mov`, BOSS);      // a drive OWNER is not in
  binned = await video('binned.mov', `${PREFIX}/binned.mov`, OWNER);
  pic = await db.createFile({
    name: 'still.jpg', url: 'https://s3.px.test/onyx-px/x', mime: 'image/jpeg', kind: 'image',
    size: 4_000_000_000, storage: 's3', storageKey: `${PREFIX}/still.jpg`, createdBy: OWNER,
  });
  made.push(cut.id, mine.id, theirs.id, secret.id, binned.id, pic.id);
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
    await db.sql`DELETE FROM invite_requests WHERE email LIKE ${`%-${tag}@px.test`}`.catch(() => {});
    if (priorStorage != null) await db.setSetting('storage.config', priorStorage, 'test').catch(() => {});
    else await db.sql`DELETE FROM settings WHERE key = 'storage.config'`.catch(() => {});
  }
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

describe('proxies against a real database', { skip }, () => {
  test('the queue holds to drives and to the write rule, and skips the trash', async () => {
    as(OWNER);
    const own = await queue();
    assert.equal(own.status, 200);
    assert.deepEqual(asked(own), [cut.id, mine.id], 'their drive’s job and their own upload — not an org file they only see, not another drive');
    as(VIEWER);
    assert.deepEqual(ids(await queue()), [], 'a drive viewer may change nothing in it, nor others’ uploads');
    as(OUTSIDER);
    assert.deepEqual(ids(await queue()), [], 'sees the library, may change none of it');
    as(BOSS);
    assert.deepEqual(asked(await queue()), [cut.id, mine.id, theirs.id, secret.id], 'an admin: everything but the trash');
    const job = (await queue()).body.jobs[0];
    assert.deepEqual(Object.keys(job).sort(), ['fileId', 'height', 'mime', 'name', 'requestedAt', 'size']);
    assert.equal(job.height, 2160, 'the source height, so a worker sees what it is in for');
    assert.match(job.requestedAt, /^\d{4}-\d\d-\d\dT/);
  });

  test('only video: an image cannot be asked for, or claimed', async () => {
    as(OWNER);
    assert.equal((await call(route.POST, pic.id, 'POST', {})).status, 400);
    assert.equal((await call(claimRoute.POST, pic.id, 'POST', { device: 'x' })).status, 404);
    assert.equal((await call(route.GET, pic.id, 'GET')).body.canRequest, false);
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
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const won = a.status === 200 ? a : b;
    const loser = a.status === 409 ? a : b;
    assert.equal(loser.body.code, 'taken');
    assert.equal(loser.body.proxyKey, undefined, 'a refused claim hands out no URL');

    const [row] = await db.sql`
      SELECT status, claimed_by, claimed_device, lease_until > now() + interval '9 minutes' AS leased, source_key, proxy_key
      FROM proxies WHERE file_id = ${cut.id}`;
    assert.equal(row.status, 'working');
    assert.ok(row.leased);
    assert.equal(row.source_key, cut.storageKey);
    // The key is the server's, minted at the claim and recorded — the winner's,
    // not the loser's, whose uuid was thrown away with its UPDATE.
    assert.ok(isProxyKey(row.proxy_key), `not a proxy key: ${row.proxy_key}`);
    assert.equal(won.body.proxyKey, row.proxy_key);

    // The two URLs are for the two objects, and the right way round: the
    // master to read, the proxy to write.
    assert.match(won.body.downloadUrl, new RegExp(encodeURIComponent(cut.storageKey).replace(/%2F/g, '/')));
    assert.match(won.body.uploadUrl, /X-Amz-Signature=/);
    assert.ok(won.body.uploadUrl.includes(encodeURIComponent(row.proxy_key).replace(/%2F/g, '/')));
    assert.equal(won.body.spec.height, PROXY_MAX_HEIGHT, 'a 2160p master is capped');
    assert.equal(won.body.spec.keyframeSeconds, 2, 'the key frame interval is the server’s to say');
    assert.equal(won.body.sourceFps, null, 'no rate on record: none sent, rather than a guess');
    assert.equal(won.body.maxBytes, PROXY_MAX_PUT_BYTES);
    assert.equal(won.body.leaseSeconds, 600);

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
    const [{ claimed_by: first, proxy_key: firstKey }] = await db.sql`SELECT claimed_by, proxy_key FROM proxies WHERE file_id = ${cut.id}`;
    const second = first === OWNER ? OTHER : OWNER;
    await db.sql`UPDATE proxies SET lease_until = now() - interval '1 minute' WHERE file_id = ${cut.id}`;
    as(second);
    assert.ok(ids(await queue()).includes(cut.id), 'back in the queue');
    const c = await call(claimRoute.POST, cut.id, 'POST', { device: 'Mac C' });
    assert.equal(c.status, 200);
    assert.notEqual(c.body.proxyKey, firstKey, 'a fresh key, so no cache holds the abandoned run’s bytes');
    assert.equal(c.body.contentHash, 'etag-cut', 'the contents, so a Mac with a copy knows it is this one');

    as(first);
    assert.equal((await call(route.PUT, cut.id, 'PUT', { width: 1920, height: 1080 })).body.code, 'lost');
    as(second);
    const done = await call(route.PUT, cut.id, 'PUT', { width: 1920, height: 1080, size: 900_000_000, duration: 1234.5 });
    assert.equal(done.status, 200);
    assert.equal(done.body.proxy.status, 'done');
    assert.equal(done.body.proxy.height, 1080);
    assert.equal(done.body.proxy.device, 'Mac C');
    assert.equal(done.body.proxy.stale, false);
    // A finished, current proxy carries a playable URL, so a page left open
    // through the transcode can switch to it without a reload.
    assert.ok(done.body.proxy.url?.includes(c.body.proxyKey), done.body.proxy.url);
    assert.match(done.body.proxy.url, /X-Amz-Signature=/);
    const [row] = await db.sql`SELECT proxy_key, lease_until, progress, finished_at, size FROM proxies WHERE file_id = ${cut.id}`;
    assert.equal(row.proxy_key, c.body.proxyKey, 'the object it was told to write, not one it chose');
    assert.equal(row.lease_until, null);
    assert.equal(row.progress, 1);
    assert.equal(Number(row.size), 900_000_000);
    assert.ok(row.finished_at);
  });

  test('a rubbish number is refused rather than stored', async () => {
    const [{ claimed_by: who }] = await db.sql`SELECT claimed_by FROM proxies WHERE file_id = ${cut.id}`;
    as(who);
    // The job is done, so these are refused for that first — but a 400 on the
    // numbers must not be reachable past it either, so re-request and re-claim.
    await call(route.POST, cut.id, 'POST', {});
    const c = await call(claimRoute.POST, cut.id, 'POST', { device: 'Mac D' });
    assert.equal(c.status, 200);
    // Every value here survives JSON — Infinity would arrive as null, which
    // means "left out", so testing with it would prove nothing.
    for (const bad of [{ width: 0 }, { height: -1 }, { size: 'big' }, { duration: 'soon' }, { duration: 1e12 }, { width: 1920.5 }]) {
      const r = await call(route.PUT, cut.id, 'PUT', bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    // And nothing was written: the job is still working.
    const [row] = await db.sql`SELECT status FROM proxies WHERE file_id = ${cut.id}`;
    assert.equal(row.status, 'working');
    // Left finished, for the next test.
    assert.equal((await call(route.PUT, cut.id, 'PUT', {})).status, 200, 'every number is optional');
  });

  test('replacing the file’s bytes makes the proxy stale, and it stops being served', async () => {
    as(OWNER);
    assert.equal((await call(route.GET, cut.id, 'GET')).body.proxy.stale, false);
    await db.sql`UPDATE files SET storage_key = ${`${PREFIX}/cut v2.mov`} WHERE id = ${cut.id}`;
    const after = (await call(route.GET, cut.id, 'GET')).body.proxy;
    assert.equal(after.stale, true);
    assert.equal(after.url, null, 'and nothing playable is handed out for it');
    // attachProxies is what the detail page joins through, and a stale proxy
    // gets no key there — so presignFileUrls has nothing to sign and the player
    // streams the master rather than the wrong footage.
    const [joined] = await db.attachProxies([await db.getFileById(cut.id)]);
    assert.equal(joined.proxyKey, null);
    assert.equal(joined.proxyStale, true);
    assert.equal(joined.proxyStatus, 'done');
  });

  test('the rendition’s object is collectable, but only once no job names it', async () => {
    const { dropUnusedPreviews } = await import('../lib/preview-gc.js');
    const { proxyKeyFor } = await import('../lib/media.js');
    const key = proxyKeyFor('11111111-2222-3333-4444-555555555555');
    await db.sql`UPDATE proxies SET status = 'done', proxy_key = ${key} WHERE file_id = ${theirs.id}`;

    // Read from the job row, because it is not a column on `files` — which is
    // why a purge has to ask BEFORE deleting the row.
    assert.deepEqual(await db.proxyKeysFor([theirs.id]), [key]);

    const removed = [];
    const remove = (k) => { removed.push(k); return true; };
    assert.equal(await dropUnusedPreviews({ proxyKeys: [key] }, { remove }), 0, 'a live job still names it');
    assert.deepEqual(removed, []);

    const gone = await db.deleteProxy(theirs.id);
    assert.deepEqual(gone, { removed: true, key }, 'the delete says which object to collect');
    assert.equal(await dropUnusedPreviews({ proxyKeys: [key] }, { remove }), 1);
    assert.deepEqual(removed, [key]);

    // And nothing else is ever a candidate, whatever is passed in.
    removed.length = 0;
    assert.equal(await dropUnusedPreviews({ proxyKeys: [`${PREFIX}/cut.mov`, '_thumbs/x.proxy.mp4'] }, { remove }), 0);
    assert.deepEqual(removed, []);
  });

  test('re-requesting hands back the object the abandoned run wrote', async () => {
    const { proxyKeyFor } = await import('../lib/media.js');
    const key = proxyKeyFor('99999999-8888-7777-6666-555555555555');
    await db.sql`UPDATE proxies SET status = 'done', proxy_key = ${key} WHERE file_id = ${secret.id}`;
    const again = await db.requestProxy(secret.id, { requestedBy: BOSS });
    assert.equal(again.status, 'queued');
    assert.equal(again.abandonedKey, key, 'so the route can delete it');
    assert.equal(again.proxyKey, null, 'and nothing points at it any more');
  });

  test('a drive viewer reads it and is offered nothing; an outsider cannot see it', async () => {
    as(VIEWER);
    const r = await call(route.GET, cut.id, 'GET');
    assert.equal(r.status, 200);
    assert.equal(r.body.proxy.status, 'done');
    assert.equal(r.body.canRequest, false);
    assert.equal(r.body.canDelete, false);
    assert.equal((await call(route.POST, cut.id, 'POST', {})).status, 403);
    assert.equal((await call(route.DELETE, cut.id, 'DELETE')).status, 403);
    assert.equal((await call(claimRoute.POST, cut.id, 'POST', { device: 'x' })).status, 403);
    as(OUTSIDER);
    assert.equal((await call(route.GET, cut.id, 'GET')).status, 404);
  });

  test('a claimer’s email is never in the answer', async () => {
    as(VIEWER);
    const body = JSON.stringify((await call(route.GET, cut.id, 'GET')).body);
    assert.ok(!body.includes('@px.test'), body);
    // Nor the source key — not even through the signed URL, which is for the
    // rendition under _thumbs/ and names nothing about where the master lives.
    assert.ok(!body.includes(PREFIX), body);
  });

  test('purging a file takes its proxy job with it', async () => {
    await db.deleteFile(mine.id);
    const rows = await db.sql`SELECT 1 FROM proxies WHERE file_id = ${mine.id}`;
    assert.equal(rows.length, 0);
  });

  test('DELETE forgets it', async () => {
    as(OWNER);
    assert.deepEqual((await call(route.DELETE, cut.id, 'DELETE')).body, { ok: true });
    assert.deepEqual((await call(route.GET, cut.id, 'GET')).body.proxy.status, 'none');
  });
  test('a large video no one asked for is offered after the rest, and claiming it makes its job', async () => {
    const file = (name, size) => db.createFile({
      name, url: `https://s3.px.test/onyx-px/${PREFIX}/${name}`, mime: 'video/mp4', kind: 'video',
      size, storage: 's3', storageKey: `${PREFIX}/${name}`, createdBy: OWNER, metadata: { width: 3840, height: 2160 },
    });
    const quiet = await file('quiet.mp4', 3_000_000_000);  // from before proxies were asked for at upload
    const short = await file('short.mp4', 50_000_000);     // too small to be worth one
    made.push(quiet.id, short.id);

    as(OWNER);
    const q = await queue();
    const at = ids(q).indexOf(quiet.id);
    assert.ok(at >= 0, 'offered');
    assert.ok(at >= asked(q).length, 'after everything someone asked for');
    assert.equal(q.body.jobs[at].requestedAt, null, 'no one asked: no job yet');
    assert.ok(!ids(q).includes(short.id), 'a small video is not worth one');
    as(VIEWER);
    assert.ok(!ids(await queue()).includes(quiet.id), 'a drive viewer is offered nothing');
    as(OUTSIDER);
    assert.ok(!ids(await queue()).includes(quiet.id), 'nor someone outside the drive');

    // Claiming it makes the job, and it is a claim like any other.
    as(OTHER);
    const got = await call(claimRoute.POST, quiet.id, 'POST', { device: 'Other’s Mac' });
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.ok(isProxyKey(got.body.proxyKey));
    assert.equal((await db.getProxy(quiet.id)).status, 'working');
    as(OWNER);
    assert.equal((await call(claimRoute.POST, quiet.id, 'POST', {})).status, 409, 'taken, as any job is');
    assert.ok(!ids(await queue()).includes(quiet.id), 'offered no more: it has a job now');

    // No job is made for one that should not have one.
    assert.equal((await call(claimRoute.POST, short.id, 'POST', {})).status, 404);
    assert.equal(await db.getProxy(short.id), null);
  });

  test('a small video some browser will not play is offered too, by its probed codec', async () => {
    const file = (name, videoCodec, more = {}) => db.createFile({
      name, url: `https://s3.px.test/onyx-px/${PREFIX}/${name}`, mime: 'video/quicktime', kind: 'video',
      size: 150_000_000, storage: 's3', storageKey: `${PREFIX}/${name}`, createdBy: OWNER,
      metadata: { width: 3840, height: 2160, ...(videoCodec ? { videoCodec } : {}), ...more },
    });
    const hdr = await file('IMG_0042.MOV', { fourcc: 'hvc1', bitDepth: 10, chroma: '4:2:0', hdr: true });
    const prores = await file('A001_C002.mov', { fourcc: 'apcn' }, { fps: { num: 24000, den: 1001 }, tcStart: 0, dropFrame: false });
    const xavc = await file('C0001.mp4', { fourcc: 'avc1', bitDepth: 10, chroma: '4:2:2' });
    const h264 = await file('export.mp4', { fourcc: 'avc1', bitDepth: 8, chroma: '4:2:0', hdr: false });
    const unknown = await file('before.mov', null);
    made.push(hdr.id, prores.id, xavc.id, h264.id, unknown.id);

    as(OWNER);
    const offered = ids(await queue());
    for (const f of [hdr, prores, xavc]) assert.ok(offered.includes(f.id), `${f.name} is offered`);
    assert.ok(!offered.includes(h264.id), 'H.264 every browser plays is not worth one at this size');
    assert.ok(!offered.includes(unknown.id), 'nor a file whose codec no probe has read: its size decides');

    // The claim's own check agrees with the offer.
    as(OTHER);
    const got = await call(claimRoute.POST, prores.id, 'POST', { device: 'Other’s Mac' });
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.deepEqual(got.body.sourceFps, { num: 24000, den: 1001 }, 'the rate a worker counts the key frame interval at');
    assert.equal((await db.getProxy(prores.id)).status, 'working');
    assert.equal((await call(claimRoute.POST, h264.id, 'POST', {})).status, 404);
    assert.equal(await db.getProxy(h264.id), null);
  });

  test('a Mac saving power is listed the large jobs alone, before the page is cut', async () => {
    const { PROXY_MIN_BYTES } = await import('../lib/proxies.js');
    const hevc = { fourcc: 'hvc1', bitDepth: 10, chroma: '4:2:0', hdr: true };
    const file = (name, size) => db.createFile({
      name, url: `https://s3.px.test/onyx-px/${PREFIX}/${name}`, mime: 'video/quicktime', kind: 'video',
      size, storage: 's3', storageKey: `${PREFIX}/${name}`, createdBy: OWNER, metadata: { videoCodec: hevc },
    });
    // Eleven phone clips someone asked for, then a master: more than a page
    // of small jobs ahead of the one a Mac on its battery would take.
    const clips = [];
    for (let i = 0; i < 11; i++) clips.push(await file(`IMG_2${String(i).padStart(3, '0')}.MOV`, 150_000_000));
    made.push(...clips.map((f) => f.id));
    for (const f of clips) await db.requestProxy(f.id, { requestedBy: OWNER });
    const master = await file('A002_C001.mov', PROXY_MIN_BYTES + 1);
    // And one with no job, which the offer would list for its codec.
    const offeredClip = await file('IMG_2999.MOV', 150_000_000);
    made.push(master.id, offeredClip.id);
    await db.requestProxy(master.id, { requestedBy: OWNER });

    as(OWNER);
    const all = await queue();
    assert.equal(all.status, 200);
    assert.ok(!ids(all).includes(master.id), 'behind a page of clips, as a Mac on power sees it');
    const large = await queue('?large=1');
    assert.equal(large.status, 200);
    const got = ids(large);
    assert.ok(got.includes(master.id), 'the master, which the clips no longer hide');
    for (const f of [...clips, offeredClip]) assert.ok(!got.includes(f.id), `${f.name}: small, there for its codec`);
    assert.ok(large.body.jobs.every((j) => j.size == null || j.size >= PROXY_MIN_BYTES), JSON.stringify(large.body.jobs));
    for (const f of clips) await db.deleteProxy(f.id);
    await db.deleteProxy(master.id);
  });

  test('a drive they only view does not fill the offer: the query leaves its rows out', async () => {
    const { buildProxyCandidateQuery } = await import('../lib/file-query.js');
    const { getPrincipal } = await import('../lib/authz.js');
    const { PROXY_MIN_BYTES, EVERY_BROWSER_CODECS } = await import('../lib/proxies.js');
    const viewed = await db.createFilespace({ name: `Pxv ${tag}`, bucket: 'onyx-px', prefix: `pxv-${tag}`, createdBy: BOSS });
    try {
      await db.grantFilespaceAccess({ filespaceId: viewed.id, email: OWNER, role: 'viewer' });
      const clip = (name, prefix) => db.createFile({
        name, url: `https://s3.px.test/onyx-px/${prefix}/${name}`, mime: 'video/quicktime', kind: 'video',
        size: 150_000_000, storage: 's3', storageKey: `${prefix}/${name}`, createdBy: BOSS,
        metadata: { videoCodec: { fourcc: 'hvc1', bitDepth: 10, chroma: '4:2:0', hdr: true } },
      });
      const ours = await clip('IMG_1001.MOV', PREFIX);
      const viewedOnly = await clip('IMG_1002.MOV', viewed.prefix);
      const handed = await clip('IMG_1003.MOV', viewed.prefix);
      made.push(ours.id, viewedOnly.id, handed.id);
      await db.sql`
        INSERT INTO file_acl (file_id, scope, principal, access, granted_by, granted_at)
        VALUES (${handed.id}, 'user', ${OWNER}, 'editor', ${BOSS}, ${Date.now()})`;

      const principal = await getPrincipal(OWNER);
      const q = buildProxyCandidateQuery({ principal, minBytes: PROXY_MIN_BYTES, playable: EVERY_BROWSER_CODECS, limit: 500 });
      const rows = (await db.sql.unsafe(q.text, q.params)).map((r) => r.id);
      assert.ok(rows.includes(ours.id), 'their own drive’s');
      assert.ok(rows.includes(handed.id), 'one shared with them to edit');
      assert.ok(!rows.includes(viewedOnly.id), 'not one in a drive they only view');
      assert.ok((await db.visibleFileIds([viewedOnly.id], principal)).has(viewedOnly.id), 'though they see it');

      as(OWNER);
      const offered = ids(await queue());
      assert.ok(offered.includes(ours.id) && offered.includes(handed.id));
      assert.ok(!offered.includes(viewedOnly.id));
    } finally {
      await db.deleteFilespace(viewed.id).catch(() => {});
    }
  });

  test('a listing signs the finished, current rendition of a heavy video, and nothing else', async () => {
    const { proxyKeyFor } = await import('../lib/media.js');
    const { listFilesPage } = await import('../lib/file-listing.js');
    const { getPrincipal } = await import('../lib/authz.js');
    const folder = `Listing ${tag}`;
    const video = (name, size = 3_000_000_000) => db.createFile({
      name, url: `https://s3.px.test/onyx-px/${PREFIX}/${folder}/${name}`, mime: 'video/mp4', kind: 'video',
      size, storage: 's3', storageKey: `${PREFIX}/${folder}/${name}`, folder, createdBy: OWNER,
    });
    const done = await video('done.mp4');
    const stale = await video('stale.mp4');
    const queued = await video('queued.mp4');
    const small = await video('small.mp4', 50_000_000);
    made.push(done.id, stale.id, queued.id, small.id);
    const job = (f, status, key, sourceKey) => db.sql`
      INSERT INTO proxies (file_id, status, proxy_key, source_key, requested_at, updated_at)
      VALUES (${f.id}, ${status}, ${key}, ${sourceKey}, now(), now())`;
    const key = proxyKeyFor(randomUUID());
    const smallKey = proxyKeyFor(randomUUID());
    await job(done, 'done', key, done.storageKey);
    await job(stale, 'done', proxyKeyFor(randomUUID()), `${PREFIX}/${folder}/stale v1.mp4`);
    await job(queued, 'queued', null, null);
    await job(small, 'done', smallKey, small.storageKey);

    // The query: a finished job's key, and only while it is of these contents.
    const keys = await db.finishedProxyKeys([done, stale, queued, small]);
    assert.equal(keys.size, 2);
    assert.equal(keys.get(done.id), key);
    assert.equal(keys.get(small.id), smallKey);
    assert.equal((await db.finishedProxyKeys([])).size, 0);

    // The listing asks it only about a video worth a proxy, and signs what it says.
    const p = await getPrincipal(OWNER);
    const page = await listFilesPage({ principal: p, opts: { folder }, storagePrefix: PREFIX });
    const rows = new Map(page.files.map((f) => [f.name, f]));
    assert.equal(rows.size, 4);
    assert.ok(rows.get('done.mp4').proxyUrl?.includes(key), rows.get('done.mp4').proxyUrl);
    assert.match(rows.get('done.mp4').proxyUrl, /X-Amz-Signature=/);
    for (const name of ['stale.mp4', 'queued.mp4', 'small.mp4']) assert.equal(rows.get(name).proxyUrl, undefined, name);
    assert.equal(rows.get('done.mp4').can.edit, true, 'and what they may do to each, as before');

    // With the flag off for them, none.
    const off = await listFilesPage({ principal: { ...p, flags: { ...p.flags, proxies: false } }, opts: { folder }, storagePrefix: PREFIX });
    assert.equal(off.files.length, 4);
    assert.ok(off.files.every((f) => !f.proxyUrl));
  });

  test('a failed job is not offered again', async () => {
    const failed = await db.createFile({
      name: 'broken.mp4', url: `https://s3.px.test/onyx-px/${PREFIX}/broken.mp4`, mime: 'video/mp4', kind: 'video',
      size: 3_000_000_000, storage: 's3', storageKey: `${PREFIX}/broken.mp4`, createdBy: OWNER,
    });
    made.push(failed.id);
    assert.equal(await db.queueProxyIfMissing(failed.id), true);
    await db.sql`UPDATE proxies SET status = 'failed', error = 'unreadable' WHERE file_id = ${failed.id}`;
    as(OWNER);
    assert.ok(!ids(await queue()).includes(failed.id));
    assert.equal(await db.queueProxyIfMissing(failed.id), false, 'a job of any kind is left as it is');
    assert.equal((await db.getProxy(failed.id)).status, 'failed');
  });
});
