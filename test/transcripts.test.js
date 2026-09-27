// Transcripts: the pure half of the contract between the server and Onyx for
// Mac (lib/transcripts.js) — what a body may carry, who may do what, the
// API's shape, the exports — and the places the server half has to keep a
// promise that no single function shows: the queue's drive clause, the purge
// taking the row, the cookie gate letting a Mac's bearer token through.
// No database; the routes themselves are test/transcripts-api.test.js.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const T = await import('../lib/transcripts.js');
const { buildTranscriptQueueQuery } = await import('../lib/file-query.js');
const { principalFrom, can } = await import('../lib/authz.js');
const { DEFAULT_FLAGS, getFlag } = await import('../lib/features.js');

const src = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');

describe('normalizeSegments', () => {
  test('rounds to 3 decimals, collapses whitespace, and sorts by time', () => {
    const out = T.normalizeSegments([
      { s: 2.00049, e: 3.9996, t: '  second\n  line ' },
      { s: 0, e: 2.1, t: 'first' },
    ]);
    assert.deepEqual(out.segments, [
      { s: 0, e: 2.1, t: 'first' },
      { s: 2, e: 4, t: 'second line' },
    ]);
  });

  test('an empty transcript is a transcript (a clip with no speech)', () => {
    assert.deepEqual(T.normalizeSegments([]).segments, []);
  });

  test('refuses what is not a list of segments', () => {
    assert.match(T.normalizeSegments(null).error, /list/);
    assert.match(T.normalizeSegments({ s: 0 }).error, /list/);
    assert.match(T.normalizeSegments([null]).error, /Segment 1/);
    assert.match(T.normalizeSegments([[0, 1, 'x']]).error, /Segment 1/);
  });

  test('times must be finite numbers, 0 or more, and end at or after the start', () => {
    const bad = [
      { s: -1, e: 1, t: 'x' }, { s: 0, e: Infinity, t: 'x' }, { s: NaN, e: 1, t: 'x' },
      { s: '0', e: 1, t: 'x' }, { s: 0, t: 'x' },
    ];
    for (const seg of bad) assert.match(T.normalizeSegments([seg]).error, /start and an end/, JSON.stringify(seg));
    assert.match(T.normalizeSegments([{ s: 0, e: 1, t: 'ok' }, { s: 5, e: 4, t: 'x' }]).error, /Segment 2 ends before it starts/);
    assert.ok(T.normalizeSegments([{ s: 4, e: 4, t: 'an instant' }]).segments, 'e = s is allowed');
  });

  test('text is 1–1000 characters after trimming, counted as characters, not UTF-16 units', () => {
    assert.match(T.normalizeSegments([{ s: 0, e: 1, t: '   ' }]).error, /no text/);
    assert.match(T.normalizeSegments([{ s: 0, e: 1, t: 42 }]).error, /no text/);
    assert.ok(T.normalizeSegments([{ s: 0, e: 1, t: 'a'.repeat(1000) }]).segments);
    assert.match(T.normalizeSegments([{ s: 0, e: 1, t: 'a'.repeat(1001) }]).error, /longer than 1000/);
    // 1000 emoji are 2000 UTF-16 units and still 1000 characters.
    assert.ok(T.normalizeSegments([{ s: 0, e: 1, t: '🎬'.repeat(1000) }]).segments);
  });

  test('at most 20,000 segments', () => {
    const seg = { s: 0, e: 1, t: 'x' };
    assert.ok(T.normalizeSegments(Array(20000).fill(seg)).segments);
    assert.match(T.normalizeSegments(Array(20001).fill(seg)).error, /at most 20,000/);
  });

  test('the search text is the segments joined with spaces', () => {
    assert.equal(T.segmentsText([{ t: 'a' }, { t: 'b c' }]), 'a b c');
  });
});

describe('the other fields', () => {
  test('languages are BCP-47 tags, or null for the Mac’s own', () => {
    assert.deepEqual(T.normalizeLanguage(undefined), { value: null });
    assert.deepEqual(T.normalizeLanguage(null), { value: null });
    assert.deepEqual(T.normalizeLanguage(' en-US '), { value: 'en-US' });
    assert.deepEqual(T.normalizeLanguage('pt_BR'), { value: 'pt-BR' }, 'an Apple locale identifier');
    assert.deepEqual(T.normalizeLanguage('zh-Hans-CN'), { value: 'zh-Hans-CN' });
    for (const bad of ['english', 'e', '12-34', 'en US', 'en-US; drop table', 42, {}]) {
      assert.ok(T.normalizeLanguage(bad).error, String(bad));
    }
  });

  test('the device name is cleaned and cut to 80 characters', () => {
    assert.equal(T.normalizeDevice('  Ricky’s\nMacBook   Pro '), 'Ricky’s MacBook Pro');
    assert.equal(T.normalizeDevice('M'.repeat(200)).length, 80);
    assert.equal(T.normalizeDevice(''), null);
    assert.equal(T.normalizeDevice(7), null);
  });

  test('progress is a finite number held to 0..1', () => {
    assert.equal(T.progressValue(0.37), 0.37);
    assert.equal(T.progressValue(1.4), 1);
    assert.equal(T.progressValue(-2), 0);
    for (const bad of [NaN, Infinity, '0.5', null, undefined]) assert.equal(T.progressValue(bad), null);
  });

  test('a failure is cut to 500 characters rather than refused', () => {
    assert.equal(T.failureMessage('x'.repeat(900)).length, 500);
    assert.equal(T.failureMessage(''), 'Transcription failed.');
    assert.equal(T.failureMessage({}), 'Transcription failed.');
  });

  test('engines are short identifiers', () => {
    assert.deepEqual(T.normalizeEngine('apple-speechanalyzer'), { value: 'apple-speechanalyzer' });
    assert.deepEqual(T.normalizeEngine(undefined), { value: null });
    assert.ok(T.normalizeEngine('<script>').error);
    assert.ok(T.normalizeEngine('x'.repeat(65)).error);
  });
});

describe('transcriptDecision', () => {
  const ok = { ok: true };
  const all = { flagOn: true, live: true, canRead: true, edit: ok, canModify: true, kind: 'video' };
  const writes = ['request', 'delete', 'claim', 'report', 'submit'];

  test('flag off: a read is a 404, everything else a 403', () => {
    assert.equal(T.transcriptDecision('read', { ...all, flagOn: false }).status, 404);
    for (const a of writes) assert.equal(T.transcriptDecision(a, { ...all, flagOn: false }).status, 403, a);
  });

  test('a trashed or missing file is 404 — but a Mac reporting on it has lost its job', () => {
    for (const a of ['read', 'request', 'delete', 'claim']) assert.equal(T.transcriptDecision(a, { ...all, live: false }).status, 404, a);
    for (const a of ['report', 'submit']) {
      const d = T.transcriptDecision(a, { ...all, live: false });
      assert.equal(d.status, 409);
      assert.equal(d.code, 'lost');
    }
  });

  test('a file you cannot see is 404 for everything, never a 403 that confirms it', () => {
    for (const a of ['read', ...writes]) assert.equal(T.transcriptDecision(a, { ...all, canRead: false }).status, 404, a);
  });

  test('reading needs only access to the file', () => {
    assert.ok(T.transcriptDecision('read', { ...all, edit: { ok: false, status: 403, reason: 'no' }, canModify: false }).ok);
  });

  test('every write takes files.edit AND write access to the file', () => {
    for (const a of writes) {
      const noCap = T.transcriptDecision(a, { ...all, edit: { ok: false, status: 403, reason: 'Your role can view files but not change them.' } });
      assert.equal(noCap.status, 403, a);
      assert.match(noCap.error, /view files/);
      assert.equal(T.transcriptDecision(a, { ...all, canModify: false }).status, 403, a);
      assert.ok(T.transcriptDecision(a, all).ok, a);
    }
  });

  test('a degraded principal is told to retry, not refused', () => {
    const d = T.transcriptDecision('request', { ...all, edit: { ok: false, status: 503, reason: 'try again', code: 'degraded' } });
    assert.equal(d.status, 503);
    assert.equal(d.code, 'degraded');
  });

  test('only video and audio can be requested or claimed', () => {
    assert.ok(T.transcriptDecision('request', { ...all, kind: 'audio' }).ok);
    assert.equal(T.transcriptDecision('request', { ...all, kind: 'image' }).status, 400);
    assert.equal(T.transcriptDecision('claim', { ...all, kind: 'doc' }).status, 404);
    assert.ok(T.transcriptDecision('delete', { ...all, kind: 'doc' }).ok, 'a stray row can always be removed');
  });

  test('with real principals: a Viewer reads, and cannot request; a Member and an admin can', () => {
    const drive = { id: 'd1', prefix: 'team' };
    const viewer = principalFrom({ email: 'v@x.test', person: { roleId: 'viewer' }, globalFlags: DEFAULT_FLAGS, grants: { drives: [drive], roles: { d1: 'editor' } } });
    const member = principalFrom({ email: 'm@x.test', person: { roleId: 'member' }, globalFlags: DEFAULT_FLAGS, grants: { drives: [drive], roles: { d1: 'editor' } } });
    const admin = principalFrom({ email: 'a@x.test', isAdmin: true, globalFlags: DEFAULT_FLAGS });
    const at = (p, canModify) => ({ ...all, edit: can(p, 'files.edit'), canModify });
    assert.ok(T.transcriptDecision('read', at(viewer, false)).ok);
    assert.equal(T.transcriptDecision('request', at(viewer, false)).status, 403);
    assert.equal(T.transcriptDecision('claim', at(viewer, false)).status, 403);
    assert.equal(T.transcriptDecision('submit', at(viewer, false)).status, 403);
    assert.ok(T.transcriptDecision('request', at(member, true)).ok);
    assert.ok(T.transcriptDecision('claim', at(admin, true)).ok);
  });
});

describe('the flag', () => {
  test('is registered as the contract says, on by default, read on the server', () => {
    const f = getFlag('transcripts');
    assert.equal(f.category, 'Library');
    assert.equal(f.default, true);
    assert.equal(f.enforcement, 'server');
    assert.match(f.enforcedBy, /transcript/);
    assert.equal(DEFAULT_FLAGS.transcripts, true);
  });

  test('every route reads it for itself', async () => {
    const guard = await src('lib/transcript-guard.js');
    assert.match(guard, /isFeatureEnabled\(principal\.flags, 'transcripts'\)/);
    for (const p of ['app/api/files/[id]/transcript/route.js', 'app/api/files/[id]/transcript/claim/route.js']) {
      const route = await src(p);
      const handlers = route.split(/export async function /).slice(1);
      assert.ok(handlers.length > 0, p);
      for (const h of handlers) assert.match(h, /openTranscript\(req, params\.id, '/, `${p} ${h.slice(0, 6)}`);
    }
    const queue = await src('app/api/transcripts/queue/route.js');
    assert.match(queue, /isFeatureEnabled\(principal\.flags, 'transcripts'\)\) return json\(\{ jobs: \[\] \}\)/);
  });
});

describe('transcriptJson', () => {
  const row = {
    status: 'done', language: null, resultLanguage: 'en-US', engine: 'apple-speechanalyzer',
    segments: [{ s: 0, e: 1, t: 'hi' }], progress: 1, error: null, sourceKey: 'files/a.mov', claimedBy: 'm@x.test',
    requestedBy: 'm@x.test', requestedAt: new Date('2026-09-01T10:00:00Z'), claimedDevice: 'Mac', text: 'hi',
    finishedAt: new Date('2026-09-01T10:05:00Z'), updatedAt: new Date('2026-09-01T10:05:00Z'), leaseUntil: null,
  };

  test('the contract’s fields and no more: no claimer email, key, search text or lease', () => {
    const out = T.transcriptJson(row, { storageKey: 'files/a.mov' });
    assert.deepEqual(Object.keys(out).sort(), [
      'claimedDevice', 'engine', 'error', 'finishedAt', 'language', 'progress', 'requestedAt', 'requestedBy',
      'resultLanguage', 'segments', 'stale', 'status', 'updatedAt',
    ]);
    assert.equal(out.requestedAt, '2026-09-01T10:00:00.000Z');
    assert.equal(out.stale, false);
    assert.equal(T.transcriptJson(null), null);
    assert.deepEqual(T.transcriptJson({ ...row, segments: null }).segments, []);
  });

  test('stale: done, and made from a key the file no longer has', () => {
    assert.equal(T.transcriptJson(row, { storageKey: 'files/a-v2.mov' }).stale, true);
    assert.equal(T.transcriptJson({ ...row, status: 'queued' }, { storageKey: 'files/a-v2.mov' }).stale, false, 'only once done');
    assert.equal(T.isStale({ ...row, sourceKey: null }, { storageKey: null }), false);
  });
});

describe('formats', () => {
  const segs = [
    { s: 0, e: 2.1, t: 'Hello there.' },
    { s: 3723.4567, e: 3725, t: 'a <b> & c --> d' },
  ];

  test('SRT: numbered, comma milliseconds, hours past an hour', () => {
    assert.equal(T.toSRT(segs), '1\n00:00:00,000 --> 00:00:02,100\nHello there.\n\n2\n01:02:03,457 --> 01:02:05,000\na <b> & c --> d\n');
  });

  test('VTT: a header, dot milliseconds, and markup escaped so no cue breaks', () => {
    const vtt = T.toVTT(segs);
    assert.ok(vtt.startsWith('WEBVTT\n\n00:00:00.000 --> 00:00:02.100\nHello there.\n'));
    assert.match(vtt, /a &lt;b&gt; &amp; c --&gt; d/);
    assert.equal(vtt.split('-->').length - 1, 2, 'only the timing lines carry an arrow');
  });

  test('text: a segment to a line', () => {
    assert.equal(T.toText(segs), 'Hello there.\na <b> & c --> d\n');
    assert.equal(T.toText([]), '');
  });

  test('names and clocks', () => {
    assert.equal(T.exportName('Interview.final.mov', 'srt'), 'Interview.final.srt');
    assert.equal(T.exportName('', 'vtt'), 'transcript.vtt');
    assert.equal(T.clockLabel(75.9), '1:15');
    assert.equal(T.clockLabel(75, true), '0:01:15');
    assert.equal(T.clockLabel(3725), '1:02:05');
  });
});

describe('the playhead and search', () => {
  const segs = [{ s: 1, e: 2, t: 'a' }, { s: 2, e: 3, t: 'b' }, { s: 10, e: 11, t: 'c' }];

  test('segmentAt: the last segment to have started, -1 before the first', () => {
    assert.equal(T.segmentAt(segs, 0.5), -1);
    assert.equal(T.segmentAt(segs, 1), 0);
    assert.equal(T.segmentAt(segs, 2.5), 1);
    assert.equal(T.segmentAt(segs, 7), 1, 'lit through the pause');
    assert.equal(T.segmentAt(segs, 99), 2);
    assert.equal(T.segmentAt([], 5), -1);
  });

  test('search ignores case and accents, and highlights the original text', () => {
    const text = 'Résumé, and another RESUME';
    const ranges = T.matchRanges(text, 'resume');
    assert.deepEqual(ranges.map(([a, b]) => text.slice(a, b)), ['Résumé', 'RESUME']);
    // Decomposed accents (NFD, as some sources write them) fold the same way.
    const nfd = 'Café society';
    assert.deepEqual(T.matchRanges(nfd, 'café').map(([a, b]) => nfd.slice(a, b)), ['Café']);
  });

  test('findMatches: every occurrence, in order, from folds made once', () => {
    const lines = [{ t: 'the cat and the hat' }, { t: 'nothing' }, { t: 'The end' }];
    const folded = lines.map((x) => T.foldText(x.t));
    const found = T.findMatches(lines, 'the', folded);
    assert.deepEqual(found.map((m) => m.index), [0, 0, 2]);
    assert.deepEqual(T.findMatches(lines, '   '), []);
  });
});

describe('the server half', () => {
  test('the queue reads through the listing’s access clause, drives included', () => {
    const p = principalFrom({
      email: 'm@x.test', person: { roleId: 'member' }, globalFlags: DEFAULT_FLAGS,
      grants: { drives: [{ id: 'd1', prefix: 'secret' }, { id: 'd2', prefix: 'team' }], roles: { d2: 'editor' } },
    });
    const q = buildTranscriptQueueQuery({ principal: p });
    assert.match(q.text, /f\.deleted_at IS NULL/);
    // `j` is the queue table's alias — buildJobQueueQuery serves both queues,
    // so the alias is the queue's rather than the transcripts table's own.
    assert.match(q.text, /j\.status = 'queued' OR \(j\.status = 'working' AND \(j\.lease_until IS NULL OR j\.lease_until < now\(\)\)\)/);
    assert.match(q.text, /FROM transcripts j/);
    assert.match(q.text, /LIKE ANY/, 'the drive boundary');
    assert.ok(q.params.some((v) => Array.isArray(v) && v.includes('secret/%')));
    assert.match(q.text, /ORDER BY coalesce\(j\.requested_at/);
    const admin = buildTranscriptQueueQuery({ principal: { isAdmin: true } });
    assert.doesNotMatch(admin.text, /LIKE ANY/);
  });

  test('…and then the write rule, on every page, in lib/db.js', async () => {
    const db = await src('lib/db.js');
    const fn = db.slice(db.indexOf('export async function listTranscriptJobs'), db.indexOf('async function deleteTranscriptRow'));
    assert.match(fn, /buildTranscriptQueueQuery\(\{ principal/);
    assert.match(fn, /modifiableFileIds\(files, principal\)/);
    assert.match(fn, /isTranscribableKind\(effectiveKind\(file\)\)/);
  });

  test('the claim is one UPDATE … WHERE … RETURNING, and the lease is the contract’s 10 minutes', async () => {
    const db = await src('lib/db.js');
    const claim = db.slice(db.indexOf('export async function claimTranscript'), db.indexOf('export async function reportTranscriptProgress'));
    assert.match(claim, /UPDATE transcripts SET[\s\S]*WHERE file_id = \$\{fileId\}\s+AND \(status = 'queued' OR \(status = 'working' AND/);
    assert.match(claim, /RETURNING \*/);
    assert.equal(T.LEASE_SECONDS, 600);
    // Scoped to the transcript functions, not the whole file: lib/db.js now
    // holds a second worker queue with a lease of its own (proxies), and a
    // file-wide count would grow with every queue instead of pinning that a
    // transcript's lease is renewed in exactly two places.
    const leases = db.slice(db.indexOf('export async function claimTranscript'), db.indexOf('async function deleteTranscriptRow'));
    assert.equal((leases.match(/interval '10 minutes'/g) || []).length, 2, 'the claim and every progress report');
    for (const fn of ['reportTranscriptProgress', 'failTranscript', 'submitTranscript']) {
      const body = db.slice(db.indexOf(`export async function ${fn}`));
      assert.match(body.slice(0, 1200), /WHERE file_id = \$\{fileId\} AND status = 'working' AND claimed_by = \$\{email\}/, fn);
    }
  });

  test('a purged file takes its transcript with it, on every hard-delete path', async () => {
    const db = await src('lib/db.js');
    const del = db.slice(db.indexOf('export async function deleteFile'), db.indexOf('export async function setFileVisibility'));
    assert.match(del, /await deleteTranscriptRow\(id\)/);
    assert.match(db, /DELETE FROM transcripts WHERE file_id = \$\{fileId\}/);
    // The three ways a file row is removed all go through deleteFile.
    assert.match(await src('lib/maintenance.js'), /await deleteFile\(row\.id\)/);
    assert.match(await src('app/api/files/[id]/route.js'), /await deleteFile\(id\)/);
    assert.match(await src('app/api/files/folders/route.js'), /await deleteFile\(id\)/);
    assert.equal((db.match(/DELETE FROM files WHERE/g) || []).length, 1, 'no other hard delete of a file row');
  });

  test('a moved or renamed file keeps its transcript current', async () => {
    const db = await src('lib/db.js');
    for (const fn of ['setFileStorageKey', 'restoreFile', 'renameFolder']) {
      const body = db.slice(db.indexOf(`export async function ${fn}`));
      assert.match(body.slice(0, 2600), /followTranscriptKeys\(/, fn);
    }
  });

  test('the cookie gate lets a Mac’s bearer token reach the transcript routes, and nothing else new', async () => {
    const mw = await src('middleware.js');
    const pattern = /matcher:\s*\[\s*'([^']+)'/.exec(mw)[1].replace(/\\\\/g, '\\');
    const { pathToRegexp } = await import('next/dist/compiled/path-to-regexp/index.js');
    const gated = (p) => pathToRegexp(pattern).test(p);
    assert.equal(gated('/api/files/abc/transcript'), false);
    assert.equal(gated('/api/files/abc/transcript/claim'), false);
    assert.equal(gated('/api/transcripts/queue'), false);
    assert.equal(gated('/api/files/abc'), true, 'the rest of api/files stays behind the gate');
    assert.equal(gated('/api/files/abc/review'), true);
    assert.equal(gated('/files/abc'), true);
  });

  test('the claim presigns only after it has authorized and claimed, for at least an hour', async () => {
    const route = await src('app/api/files/[id]/transcript/claim/route.js');
    const post = route.slice(route.indexOf('export async function POST'));
    const open = post.indexOf("openTranscript(req, params.id, 'claim')");
    const claim = post.indexOf('claimTranscript(');
    const sign = post.indexOf('presignFileUrls(');
    assert.ok(open > 0 && open < claim && claim < sign, 'authorize → claim → presign');
    const ttl = Number(/const DOWNLOAD_URL_TTL = (\d+)/.exec(route)[1]);
    assert.ok(ttl >= 3600);
  });

  test('lib/transcripts.js stays importable by the browser', async () => {
    const mod = await src('lib/transcripts.js');
    assert.doesNotMatch(mod, /^import /m, 'no imports at all');
  });
});
