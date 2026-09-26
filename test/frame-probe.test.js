// Reading videos' frame models from their containers on the server: the
// detail page's one-file backfill and Admin → Usage's "Probe all videos"
// (lib/frame-probe.js), end to end through the real route handlers, against
// a real database, with the session and the network stubbed. Runs with
// TEST_DATABASE_URL pointing at a throwaway database, and skips without one.
//
// Blob rows are what can be exercised without a bucket: their url is read
// only when it is on Vercel Blob's host, and `fetch` here answers for a few
// such urls from the fixtures in test/fixtures/ — nothing reaches a network.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

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
process.env.ADMIN_EMAILS = 'boss@probe.test';
const skip = !live && 'TEST_DATABASE_URL not reachable';

const STUB = `data:text/javascript,${encodeURIComponent('export async function auth() { return globalThis.__probeSession || null; }')}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: STUB, shortCircuit: true };
    return next(specifier, context);
  },
});
const as = (email) => { globalThis.__probeSession = email ? { user: { email } } : null; };

const db = await import('../lib/db.js');
const { storageForKeys } = await import('../lib/drive-storage.js');
const allRoute = await import('../app/api/admin/storage/probe/route.js');
const oneRoute = await import('../app/api/files/[id]/probe/route.js');

const tag = Math.random().toString(36).slice(2, 8);
const ADMIN = 'boss@probe.test';
const EDITOR = `editor-${tag}@probe.test`;
const HOST = `https://t${tag}.public.blob.vercel-storage.com`;
const MP4 = readFileSync(new URL('./fixtures/h264-23976-tail.mp4', import.meta.url));
const MOV = readFileSync(new URL('./fixtures/prores-2997df-tc.mov', import.meta.url));

// What each url answers with: a file's bytes (as a range server does), or a
// failure. Anything else is a 404, and counted, so a test can say nothing
// was fetched from an address it did not plant.
const SERVED = new Map([
  [`${HOST}/old.mov`, MOV],
  [`${HOST}/cut.mp4`, MP4],
  [`${HOST}/clip.webm`, Buffer.from('\x1aE\xdf\xa3 not an ISO-BMFF file at all, a WebM header')],
  [`${HOST}/down.mp4`, 'fail'],
]);
const fetched = [];
function fakeFetch(url, init = {}) {
  const u = String(url);
  fetched.push(u);
  const body = SERVED.get(u);
  if (!body) return Promise.resolve(new Response('', { status: 404 }));
  if (body === 'fail') return Promise.resolve(new Response('', { status: 503 }));
  const m = /bytes=(\d+)-(\d+)/.exec(init.headers?.range || '');
  const start = m ? Number(m[1]) : 0;
  const end = m ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
  return Promise.resolve(new Response(body.subarray(start, end + 1), {
    status: 206, headers: { 'content-range': `bytes ${start}-${end}/${body.length}` },
  }));
}

const rows = {};
const made = [];
const drives = [];

before(async () => {
  if (!live) return;
  await db.adminAddApprovedInvite({ email: EDITOR, name: 'Ed', reviewedBy: 'test' });
  const video = (name, url, extra = {}) => db.createFile({
    name, url, storage: 'blob', createdBy: EDITOR, size: 1000, ...extra,
  });
  // Recorded before uploads were probed, and before the server classified
  // them: kind 'other', known to be a video only by its mime type or name.
  rows.old = await video(`old-${tag}.mov`, `${HOST}/old.mov`, { kind: 'other', mime: 'video/quicktime', metadata: { width: 64, height: 36, duration: 0.2 } });
  rows.cut = await video(`cut-${tag}.mp4`, `${HOST}/cut.mp4`, { kind: 'video', mime: 'video/mp4' });
  rows.webm = await video(`clip-${tag}.webm`, `${HOST}/clip.webm`, { kind: 'video', mime: 'video/webm' });
  rows.down = await video(`down-${tag}.mp4`, `${HOST}/down.mp4`, { kind: 'video', mime: 'video/mp4' });
  // A Blob row whose url a client pointed somewhere else: never read.
  rows.elsewhere = await video(`elsewhere-${tag}.mp4`, 'http://169.254.169.254/latest/meta-data/', { kind: 'video', mime: 'video/mp4' });
  // Already known; and a still that merely has a video's extension.
  rows.known = await video(`known-${tag}.mp4`, `${HOST}/cut.mp4`, { kind: 'video', metadata: { fps: { num: 25, den: 1 }, tcStart: 0, dropFrame: false } });
  rows.still = await video(`photo-${tag}.mov`, `${HOST}/cut.mp4`, { kind: 'other', mime: 'image/jpeg' });
  // One for the detail page's own backfill, which the full pass must not reach first.
  rows.single = await video(`single-${tag}.mov`, `${HOST}/old.mov`, { kind: 'video', mime: 'video/quicktime' });
  made.push(...Object.values(rows).map((f) => f.id));
});

after(async () => {
  if (live) {
    for (const id of made) await db.deleteFile(id).catch(() => {});
    await db.sql`DELETE FROM file_tombstones WHERE id = ANY(${made})`.catch(() => {});
    for (const d of drives) await db.deleteFilespace(d).catch(() => {});
    await db.sql`DELETE FROM invite_requests WHERE email = ${EDITOR}`.catch(() => {});
  }
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

async function post(handler, params, body) {
  const res = await handler(new Request('http://app.test/x', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  }), { params });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe('probing videos for their frame rate', { skip }, () => {
  test('the detail page\'s backfill reads one file, through the same code', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      as(EDITOR);
      const r = await post(oneRoute.POST, { id: rows.single.id });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.found, true);
      assert.deepEqual(r.body.metadata.fps, { num: 30000, den: 1001 });
      assert.equal(r.body.metadata.tcStart, 107892);
      assert.equal(r.body.metadata.dropFrame, true);
    } finally {
      globalThis.fetch = real;
    }
  });

  test('"Probe all videos" is for admins', async () => {
    as(null);
    assert.equal((await post(allRoute.POST, {})).status, 401);
    as(EDITOR);
    assert.equal((await post(allRoute.POST, {})).status, 403);
  });

  test('one pass reads every video without a rate, marks the unreadable, and leaves the rest alone', async () => {
    const before = await db.getFileById(rows.old.id);
    const real = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    fetched.length = 0;
    const total = { checked: 0, found: 0, unreadable: 0, skipped: 0, failed: 0 };
    let calls = 0;
    try {
      as(ADMIN);
      let after = '';
      for (;;) {
        const r = await post(allRoute.POST, {}, { after });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        for (const k of Object.keys(total)) total[k] += r.body[k];
        after = r.body.after;
        calls += 1;
        if (r.body.done || calls > 50) break;
      }
    } finally {
      globalThis.fetch = real;
    }
    // Other test files share this database, so the totals are at least ours.
    assert.ok(total.found >= 2 && total.unreadable >= 1 && total.failed >= 1 && total.skipped >= 1, JSON.stringify(total));

    const get = async (k) => (await db.getFileById(rows[k].id)).metadata || {};
    // Found: the exact model, merged over what the row had.
    const old = await get('old');
    assert.deepEqual(old.fps, { num: 30000, den: 1001 });
    assert.equal(old.tcStart, 107892);
    assert.equal(old.dropFrame, true);
    assert.equal(old.frames, 6);
    assert.equal(old.width, 64, 'the browser\'s size is kept');
    const after = await db.getFileById(rows.old.id);
    assert.equal(after.version, before.version, 'reading a header is not an edit');
    assert.equal(after.updatedAt, before.updatedAt);
    assert.equal(after.seq, before.seq, 'nor something a device hears about');
    assert.deepEqual((await get('cut')).fps, { num: 24000, den: 1001 });
    // Unreadable: marked, so it is not tried on every visit.
    assert.equal((await get('webm')).fpsUnknown, true);
    assert.equal((await get('webm')).fps, undefined);
    // A read that failed says nothing about the file: nothing recorded.
    assert.deepEqual(await get('down'), {});
    // A url that is not Blob's is never fetched, and nothing is recorded.
    assert.deepEqual(await get('elsewhere'), {});
    assert.ok(!fetched.some((u) => u.includes('169.254')), 'the planted address was not requested');
    // Not a video, and already known: not read at all.
    assert.equal((await get('still')).fps, undefined);
    assert.deepEqual((await get('known')).fps, { num: 25, den: 1 });

    // What is left for another pass: the failed read and the unreachable
    // row — not the recorded, the marked, the known or the still.
    const left = new Set();
    let after2 = '';
    for (;;) {
      const page = await db.listVideosMissingFrameModel({ after: after2, limit: 500 });
      for (const f of page) left.add(f.id);
      if (page.length < 500) break;
      after2 = page[page.length - 1].id;
    }
    for (const k of ['down', 'elsewhere']) assert.ok(left.has(rows[k].id), k);
    for (const k of ['old', 'cut', 'webm', 'known', 'still', 'single']) assert.ok(!left.has(rows[k].id), k);

    const summary = await db.frameModelSummary();
    assert.ok(summary.videos >= 7 && summary.missing >= 2 && summary.unreadable >= 1, JSON.stringify(summary));
  });
});

describe('which keys read an object', { skip }, () => {
  test('a drive with keys of its own is read with them; the innermost drive wins', async () => {
    const cfg = { provider: 's3', bucket: 'main', accessKeyId: 'GLOBAL', secretAccessKey: 'global-secret', region: 'us-east-1' };
    const outer = await db.createFilespace({ name: `Own ${tag}`, bucket: 'theirs', prefix: `own-${tag}`, accessKeyId: 'OUTER', secretAccessKey: 's1', createdBy: ADMIN });
    const inner = await db.createFilespace({ name: `Inner ${tag}`, bucket: 'theirs', prefix: `own-${tag}/inner`, accessKeyId: 'INNER', secretAccessKey: 's2', createdBy: ADMIN });
    const plain = await db.createFilespace({ name: `Plain ${tag}`, bucket: 'main', prefix: `plain-${tag}`, createdBy: ADMIN });
    drives.push(outer.id, inner.id, plain.id);
    const cfgFor = await storageForKeys(cfg);
    assert.equal(cfgFor(`own-${tag}/inner/a.mov`).accessKeyId, 'INNER');
    assert.equal(cfgFor(`own-${tag}/a.mov`).accessKeyId, 'OUTER');
    assert.equal(cfgFor(`own-${tag}/a.mov`).bucket, 'theirs');
    assert.equal(cfgFor(`plain-${tag}/a.mov`), cfg, 'a drive without keys is read with the deployment\'s');
    assert.equal(cfgFor(`own-${tag}x/a.mov`), cfg, 'a prefix is a folder, not the start of a name');
  });
});
