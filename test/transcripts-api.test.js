// The transcript routes, run for real, with no database: '@/lib/db',
// '@/lib/desktop-guard' and '@/lib/storage' resolve to the in-memory stand-in
// in test/fixtures/transcripts-stubs.mjs, and everything between them — the
// flag as the person has it, can(), the drive-aware access answers the stub
// is told to give, transcriptDecision, the body checks, the claim's order —
// is the code that runs in production. The principals are real ones
// (principalFrom), so a Viewer here is the Viewer role, not a flag in a test.
//
// The SQL behind the stubs is test/transcripts-db.test.js's.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const STUB = new URL('./fixtures/transcripts-stubs.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/lib/db' || specifier === '@/lib/desktop-guard' || specifier === '@/lib/storage') {
      return { url: STUB, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { principalFrom } = await import('../lib/authz.js');
const { DEFAULT_FLAGS } = await import('../lib/features.js');
const route = await import('../app/api/files/[id]/transcript/route.js');
const claimRoute = await import('../app/api/files/[id]/transcript/claim/route.js');
const queueRoute = await import('../app/api/transcripts/queue/route.js');

const DRIVE = { id: 'd1', prefix: 'team' };
const who = (email, roleId, flags = DEFAULT_FLAGS) => principalFrom({
  email, person: { roleId }, globalFlags: flags, grants: { drives: [DRIVE], roles: { d1: roleId === 'viewer' ? 'viewer' : 'editor' } },
});
const EDITOR = 'ed@tx.test';
const OTHER = 'other@tx.test';     // another editor, with a Mac of their own
const VIEWER = 'viewer@tx.test';
const READER = 'reader@tx.test';   // a Member who can see the file and not change it
const OUTSIDER = 'out@tx.test';

const VIDEO = { id: 'vid', name: 'Interview.mov', mime: 'video/quicktime', kind: 'video', size: 1234, storage: 's3', storageKey: 'team/Interview.mov', deletedAt: null };
const AUDIO = { id: 'aud', name: 'memo.m4a', mime: 'audio/mp4', kind: 'other', size: 99, storage: 's3', storageKey: 'team/memo.m4a', deletedAt: null };
const IMAGE = { id: 'img', name: 'still.jpg', mime: 'image/jpeg', kind: 'image', size: 10, storage: 's3', storageKey: 'team/still.jpg', deletedAt: null };
const TRASHED = { ...VIDEO, id: 'old', storageKey: 'team/old.mov', deletedAt: Date.now() };

function reset() {
  const files = new Map([VIDEO, AUDIO, IMAGE, TRASHED].map((f) => [f.id, { ...f }]));
  const read = new Set();
  const write = new Set();
  for (const f of files.keys()) {
    for (const e of [EDITOR, OTHER, VIEWER, READER]) read.add(`${e}|${f}`);
    for (const e of [EDITOR, OTHER]) write.add(`${e}|${f}`);
  }
  globalThis.__tx = { actor: null, files, read, write, rows: new Map(), presigned: [], queueAsked: [], jobs: [], now: Date.parse('2026-09-26T12:00:00Z') };
}
const as = (email, roleId = 'member', flags) => { globalThis.__tx.actor = email ? who(email, roleId, flags) : null; };
const OFF = { ...DEFAULT_FLAGS, transcripts: false };

async function call(handler, id, method, body, { raw } = {}) {
  const init = { method, headers: { 'content-type': 'application/json' } };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) init.body = JSON.stringify(body);
  const res = await handler(new Request(`http://app.test/api/files/${id}/transcript`, init), { params: { id } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const get = (id) => call(route.GET, id, 'GET');
const request = (id, body) => call(route.POST, id, 'POST', body);
const claim = (id, device = 'Test Mac') => call(claimRoute.POST, id, 'POST', { device });
const report = (id, body) => call(route.PATCH, id, 'PATCH', body);
const submit = (id, body) => call(route.PUT, id, 'PUT', body);
const remove = (id) => call(route.DELETE, id, 'DELETE');
const queue = async () => {
  const res = await queueRoute.GET(new Request('http://app.test/api/transcripts/queue'));
  return { status: res.status, body: await res.json().catch(() => null) };
};
const SEGMENTS = [{ s: 0, e: 2.5, t: 'Hello there.' }, { s: 2.5, e: 4, t: 'General Kenobi.' }];

beforeEach(reset);

describe('the flag, read on the server', () => {
  test('off: GET is 404, every write is 403, and the queue is empty', async () => {
    as(EDITOR, 'member');
    await request(VIDEO.id);
    as(EDITOR, 'member', OFF);
    assert.equal((await get(VIDEO.id)).status, 404);
    assert.equal((await request(VIDEO.id)).status, 403);
    assert.equal((await remove(VIDEO.id)).status, 403);
    assert.equal((await claim(VIDEO.id)).status, 403);
    assert.equal((await report(VIDEO.id, { progress: 0.5 })).status, 403);
    assert.equal((await submit(VIDEO.id, { segments: SEGMENTS })).status, 403);
    const q = await queue();
    assert.deepEqual(q.body, { jobs: [] });
    assert.equal(globalThis.__tx.queueAsked.length, 0, 'not even read');
    assert.equal(globalThis.__tx.rows.get(VIDEO.id).status, 'queued', 'nothing changed');
  });

  test('signed out is a 401', async () => {
    as(null);
    assert.equal((await get(VIDEO.id)).status, 401);
    assert.equal((await queue()).status, 401);
  });
});

describe('who may do what', () => {
  test('a Viewer reads the transcript and is offered nothing; every write is refused', async () => {
    as(EDITOR);
    await request(VIDEO.id);
    as(VIEWER, 'viewer');
    const r = await get(VIDEO.id);
    assert.equal(r.status, 200);
    assert.equal(r.body.transcript.status, 'queued');
    assert.equal(r.body.canRequest, false);
    assert.equal(r.body.canDelete, false);
    for (const out of [
      await request(VIDEO.id), await remove(VIDEO.id), await claim(VIDEO.id),
      await report(VIDEO.id, { progress: 0.2 }), await submit(VIDEO.id, { segments: SEGMENTS }),
    ]) {
      assert.equal(out.status, 403);
      assert.match(out.body.error, /role/i);
    }
    assert.equal(globalThis.__tx.presigned.length, 0, 'no URL minted for a refused claim');
    assert.deepEqual((await queue()).body, { jobs: [] }, 'a Viewer’s Mac gets no work');
    assert.equal(globalThis.__tx.queueAsked.length, 0);
  });

  test('someone who can see the file but not change it cannot request, claim or submit', async () => {
    as(READER);
    const r = await get(VIDEO.id);
    assert.equal(r.status, 200);
    assert.equal(r.body.canRequest, false);
    const refused = await request(VIDEO.id);
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /view this file but not change it/);
    as(EDITOR);
    await request(VIDEO.id);
    as(READER);
    assert.equal((await claim(VIDEO.id)).status, 403);
    assert.equal(globalThis.__tx.rows.get(VIDEO.id).status, 'queued');
  });

  test('a file you cannot see is 404, whatever you ask', async () => {
    as(OUTSIDER);
    assert.equal((await get(VIDEO.id)).status, 404);
    assert.equal((await request(VIDEO.id)).status, 404);
    assert.equal((await claim(VIDEO.id)).status, 404);
  });

  test('an editor is offered Transcribe, on video and audio only', async () => {
    as(EDITOR);
    const r = await get(VIDEO.id);
    assert.deepEqual(r.body, { transcript: null, canRequest: true, canDelete: false });
    assert.equal((await get(AUDIO.id)).body.canRequest, true, 'an audio file recorded as "other" is classified again');
    assert.equal((await get(IMAGE.id)).body.canRequest, false);
    const img = await request(IMAGE.id);
    assert.equal(img.status, 400);
    assert.match(img.body.error, /video and audio/);
  });
});

describe('requesting', () => {
  test('queues, stamps who asked, and answers with the GET body', async () => {
    as(EDITOR);
    const r = await request(VIDEO.id, { language: 'fr-FR' });
    assert.equal(r.status, 200);
    assert.equal(r.body.transcript.status, 'queued');
    assert.equal(r.body.transcript.language, 'fr-FR');
    assert.equal(r.body.transcript.requestedBy, EDITOR);
    assert.equal(r.body.canDelete, true);
    assert.equal((await request(AUDIO.id)).body.transcript.language, null, 'no body: the Mac’s own language');
    assert.equal((await request(VIDEO.id, { language: 'klingon please' })).status, 400);
  });

  test('re-requesting a working job takes it from its Mac, which is told it lost it', async () => {
    as(EDITOR);
    await request(VIDEO.id);
    assert.equal((await claim(VIDEO.id)).status, 200);
    await request(VIDEO.id);
    const after = await report(VIDEO.id, { progress: 0.5 });
    assert.equal(after.status, 409);
    assert.equal(after.body.code, 'lost');
    assert.equal((await submit(VIDEO.id, { segments: SEGMENTS })).body.code, 'lost');
  });

  test('a trashed file cannot be requested, read or claimed, and its Mac is told it lost the job', async () => {
    as(EDITOR);
    assert.equal((await request(TRASHED.id)).status, 404);
    assert.equal((await get(TRASHED.id)).status, 404);
    // A job taken before the file was trashed:
    await request(VIDEO.id);
    await claim(VIDEO.id);
    globalThis.__tx.files.get(VIDEO.id).deletedAt = Date.now();
    assert.equal((await claim(VIDEO.id)).status, 404);
    for (const out of [await report(VIDEO.id, { progress: 0.9 }), await submit(VIDEO.id, { segments: SEGMENTS })]) {
      assert.equal(out.status, 409);
      assert.equal(out.body.code, 'lost');
    }
    assert.equal(globalThis.__tx.rows.get(VIDEO.id).status, 'working', 'nothing written');
  });
});

describe('the Mac’s part', () => {
  test('claim: the job, the key it records, and a download URL minted after the claim', async () => {
    as(EDITOR);
    await request(VIDEO.id, { language: 'en-GB' });
    const c = await claim(VIDEO.id, '  Ricky’s MacBook Pro\n');
    assert.equal(c.status, 200);
    assert.deepEqual(c.body, {
      fileId: VIDEO.id, name: VIDEO.name, mime: VIDEO.mime, size: VIDEO.size, language: 'en-GB',
      sourceKey: VIDEO.storageKey, downloadUrl: `https://signed.test/${VIDEO.storageKey}?sig=1`, leaseSeconds: 600,
    });
    const row = globalThis.__tx.rows.get(VIDEO.id);
    assert.equal(row.claimedDevice, 'Ricky’s MacBook Pro');
    assert.equal(row.claimedBy, EDITOR);
    const shown = await get(VIDEO.id);
    assert.equal(shown.body.transcript.status, 'working');
    assert.equal(shown.body.transcript.claimedDevice, 'Ricky’s MacBook Pro');
    assert.equal(shown.body.transcript.progress, 0);
    assert.equal('claimedBy' in shown.body.transcript, false, 'the claimer’s address stays on the server');
  });

  test('claim: 409 taken while another Mac holds the lease, 404 with no job; a lapsed lease is claimable', async () => {
    as(EDITOR);
    assert.equal((await claim(VIDEO.id)).status, 404, 'nothing requested');
    await request(VIDEO.id);
    await claim(VIDEO.id);
    as(OTHER);
    const taken = await claim(VIDEO.id);
    assert.equal(taken.status, 409);
    assert.equal(taken.body.code, 'taken');
    globalThis.__tx.now += 11 * 60_000;
    assert.equal((await claim(VIDEO.id)).status, 200, 'the lease ran out');
    as(EDITOR);
    assert.equal((await report(VIDEO.id, { progress: 0.8 })).body.code, 'lost', 'the first Mac lost it');
  });

  test('PATCH: only the claimer, only while working; progress renews the lease', async () => {
    as(EDITOR);
    await request(VIDEO.id);
    await claim(VIDEO.id);
    globalThis.__tx.now += 9 * 60_000;
    const r = await report(VIDEO.id, { progress: 0.42 });
    assert.equal(r.status, 200);
    assert.equal(r.body.leaseSeconds, 600);
    const row = globalThis.__tx.rows.get(VIDEO.id);
    assert.equal(row.progress, 0.42);
    assert.equal(row.leaseUntil.getTime(), globalThis.__tx.now + 600_000);
    assert.equal((await report(VIDEO.id, { progress: 'half' })).status, 400);
    assert.equal((await report(VIDEO.id, { status: 'done' })).status, 400);
    as(OTHER);
    const other = await report(VIDEO.id, { progress: 0.9 });
    assert.equal(other.status, 409);
    assert.equal(other.body.code, 'lost');
    const put = await submit(VIDEO.id, { segments: SEGMENTS });
    assert.equal(put.status, 409);
    assert.equal(put.body.code, 'lost');
    assert.equal(globalThis.__tx.rows.get(VIDEO.id).progress, 0.42);
  });

  test('PATCH failed: the error is kept (cut to 500), and Retry queues again', async () => {
    as(EDITOR);
    await request(VIDEO.id);
    await claim(VIDEO.id);
    assert.equal((await report(VIDEO.id, { status: 'failed', error: 'x'.repeat(800) })).status, 200);
    const shown = (await get(VIDEO.id)).body.transcript;
    assert.equal(shown.status, 'failed');
    assert.equal(shown.error.length, 500);
    assert.equal((await report(VIDEO.id, { progress: 0.1 })).body.code, 'lost', 'a failed job is not working');
    assert.equal((await request(VIDEO.id)).body.transcript.error, null);
  });

  test('PUT: validated in full before anything is written', async () => {
    as(EDITOR);
    await request(VIDEO.id);
    await claim(VIDEO.id);
    const cases = [
      [{}, /segments/],
      [{ segments: 'hello' }, /segments/],
      [{ segments: [{ s: 1, e: 0.5, t: 'backwards' }] }, /ends before it starts/],
      [{ segments: [{ s: 0, e: 1, t: '' }] }, /no text/],
      [{ segments: [{ s: 0, e: 1, t: 'y'.repeat(1001) }] }, /1000/],
      [{ segments: Array(20001).fill({ s: 0, e: 1, t: 'x' }) }, /20,000/],
      [{ segments: SEGMENTS, resultLanguage: 'not a tag' }, /language/],
      [{ segments: SEGMENTS, engine: 'rm -rf' }, /engine/],
    ];
    for (const [body, why] of cases) {
      const r = await submit(VIDEO.id, body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
      assert.match(r.body.error, why);
    }
    assert.equal((await call(route.PUT, VIDEO.id, 'PUT', undefined, { raw: '{"segments": [' })).status, 400, 'not JSON');
    const huge = JSON.stringify({ segments: [{ s: 0, e: 1, t: 'z'.repeat(4 * 1024 * 1024) }] });
    assert.equal((await call(route.PUT, VIDEO.id, 'PUT', undefined, { raw: huge })).status, 413, 'over 4 MB');
    assert.equal(globalThis.__tx.rows.get(VIDEO.id).status, 'working', 'still waiting for a good one');
  });

  test('PUT: done, in time order, with the key it transcribed; stale once the file moves on', async () => {
    as(EDITOR);
    await request(VIDEO.id);
    const c = await claim(VIDEO.id);
    const r = await submit(VIDEO.id, {
      segments: [...SEGMENTS].reverse(), resultLanguage: 'en_US', engine: 'apple-speechanalyzer', sourceKey: c.body.sourceKey,
    });
    assert.equal(r.status, 200);
    const t = r.body.transcript;
    assert.equal(t.status, 'done');
    assert.equal(t.progress, 1);
    assert.deepEqual(t.segments, SEGMENTS);
    assert.equal(t.resultLanguage, 'en-US');
    assert.equal(t.engine, 'apple-speechanalyzer');
    assert.equal(t.stale, false);
    assert.ok(t.finishedAt);
    assert.equal(globalThis.__tx.rows.get(VIDEO.id).text, 'Hello there. General Kenobi.');
    // A new version under a new key: the transcript is of the old one.
    globalThis.__tx.files.get(VIDEO.id).storageKey = 'team/Interview v2.mov';
    assert.equal((await get(VIDEO.id)).body.transcript.stale, true);
    as(VIEWER, 'viewer');
    assert.deepEqual((await get(VIDEO.id)).body.transcript.segments, SEGMENTS, 'and a Viewer reads it');
  });

  test('DELETE: an editor removes it; a Mac still working on it is told it lost it', async () => {
    as(EDITOR);
    await request(VIDEO.id);
    await claim(VIDEO.id);
    assert.deepEqual((await remove(VIDEO.id)).body, { ok: true });
    assert.equal((await get(VIDEO.id)).body.transcript, null);
    assert.equal((await submit(VIDEO.id, { segments: SEGMENTS })).body.code, 'lost');
  });

  test('the queue: jobs shaped as the contract says, asked for with the caller’s principal', async () => {
    as(EDITOR);
    globalThis.__tx.jobs = [{ file: VIDEO, language: null, requestedAt: new Date('2026-09-26T11:00:00Z') }];
    const q = await queue();
    assert.equal(q.status, 200);
    assert.deepEqual(q.body, {
      jobs: [{ fileId: VIDEO.id, name: VIDEO.name, mime: VIDEO.mime, size: VIDEO.size, language: null, requestedAt: '2026-09-26T11:00:00.000Z' }],
    });
    assert.deepEqual(globalThis.__tx.queueAsked, [{ email: EDITOR, limit: 10 }]);
    assert.equal(globalThis.__tx.presigned.length, 0, 'the queue mints no URLs');
  });
});
