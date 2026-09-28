// The proxy rendition and its ffmpeg arguments.
//
// Every case here is a flag whose absence produces a proxy that transcodes
// SUCCESSFULLY and is then wrong — which is the worst kind of failure, because
// nothing reports it. A 10-bit pixel format that no browser plays; a moov atom
// at the end of the file so playback waits for the whole download; an odd width
// that fails the encode after an hour of work.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  proxySpec, ffmpegArgs, shouldProxy, isProxyKey, isStale, proxyJson,
  PROXY_MAX_HEIGHT, PROXY_MIN_BYTES, PROXY_MIME, LEASE_SECONDS, PROXY_STATUSES,
} = await import('../lib/proxies.js');

const flag = (args, name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};

describe('proxySpec', () => {
  test('a 4K source is capped at 1080p', () => {
    assert.equal(proxySpec({ height: 2160 }).height, PROXY_MAX_HEIGHT);
  });

  test('it never upscales', () => {
    // A 720p master proxied to 1080p is larger than the original and no better
    // to look at, which is the opposite of the point.
    assert.equal(proxySpec({ height: 720 }).height, 720);
    assert.equal(proxySpec({ height: 480 }).height, 480);
  });

  test('the height is always even', () => {
    // H.264 requires even dimensions in both axes; an odd one fails the encode
    // outright rather than rounding.
    for (const h of [1081, 721, 483, 3, 1079]) {
      assert.equal(proxySpec({ height: h }).height % 2, 0, `${h} gave an odd height`);
    }
  });

  test('an unknown height assumes the cap rather than producing nothing', () => {
    for (const bad of [undefined, null, 0, -100, NaN, 'x']) {
      assert.equal(proxySpec({ height: bad }).height, PROXY_MAX_HEIGHT, JSON.stringify(bad));
    }
    assert.equal(proxySpec().height, PROXY_MAX_HEIGHT);
  });

  test('it declares an mp4 the player can actually use', () => {
    assert.equal(proxySpec({ height: 1080 }).mime, PROXY_MIME);
  });
});

describe('ffmpegArgs', () => {
  const args = ffmpegArgs({ input: '/in.mov', output: '/out.mp4', sourceHeight: 2160 });

  test('it is an array, so a filename is never shell syntax', () => {
    // Handed to exec without a shell: a key containing a quote, a space or a
    // semicolon is one argument rather than a command. Bucket keys are chosen
    // by people.
    assert.ok(Array.isArray(args));
    const odd = ffmpegArgs({ input: "/a b; rm -rf ~/'.mov", output: '/out.mp4', sourceHeight: 1080 });
    assert.ok(odd.includes("/a b; rm -rf ~/'.mov"), 'the path must survive as a single argument');
  });

  test('yuv420p is forced', () => {
    // ProRes and 10-bit sources decode to yuv422p10, which no browser plays.
    // Without this the transcode succeeds and the proxy will not play.
    assert.equal(flag(args, '-pix_fmt'), 'yuv420p');
  });

  test('faststart is set', () => {
    // Moves the moov atom to the front. Without it the player downloads the
    // whole file before it can start, so the proxy is no better than the master.
    assert.equal(flag(args, '-movflags'), '+faststart');
  });

  test('H.264 High 4.1 and AAC stereo', () => {
    assert.equal(flag(args, '-c:v'), 'libx264');
    assert.equal(flag(args, '-profile:v'), 'high');
    assert.equal(flag(args, '-level'), '4.1');
    assert.equal(flag(args, '-c:a'), 'aac');
    // AAC 5.1 in an mp4 plays as silence in several browsers.
    assert.equal(flag(args, '-ac'), '2');
  });

  test('subtitle and data streams are dropped', () => {
    // A timecode track or a tx3g subtitle makes the mp4 muxer fail LATE —
    // after the whole video has been encoded.
    assert.ok(args.includes('-sn'));
    assert.ok(args.includes('-dn'));
  });

  test('a bigger-than-target source is scaled with an even width', () => {
    // -2 preserves the aspect ratio and forces the width even.
    assert.equal(flag(args, '-vf'), 'scale=-2:1080');
  });

  test('a source at or below the target is not scaled at all', () => {
    for (const h of [1080, 720, 480]) {
      const a = ffmpegArgs({ input: '/in.mp4', output: '/out.mp4', sourceHeight: h });
      assert.equal(a.indexOf('-vf'), -1, `${h}p should not be re-sampled`);
    }
  });

  test('an unknown source height still scales, so a 4K master cannot slip through', () => {
    const a = ffmpegArgs({ input: '/in.mov', output: '/out.mp4', sourceHeight: null });
    assert.equal(flag(a, '-vf'), `scale=-2:${PROXY_MAX_HEIGHT}`);
  });

  test('bufsize is twice maxrate, and both are present', () => {
    const rate = Number(String(flag(args, '-maxrate')).replace('k', ''));
    const buf = Number(String(flag(args, '-bufsize')).replace('k', ''));
    assert.ok(rate > 0);
    assert.equal(buf, rate * 2);
  });

  test('progress is reported on stdout, so the lease can be renewed', () => {
    assert.equal(flag(args, '-progress'), 'pipe:1');
    // -nostdin, or ffmpeg consumes the parent's stdin and a spawned worker
    // hangs waiting for input that never comes.
    assert.ok(args.includes('-nostdin'));
  });

  test('the output is last and the input is named once', () => {
    assert.equal(args[args.length - 1], '/out.mp4');
    assert.equal(args.filter((a) => a === '-i').length, 1);
  });

  test('a missing path throws rather than building a broken command', () => {
    assert.throws(() => ffmpegArgs({ output: '/out.mp4' }), /input/);
    assert.throws(() => ffmpegArgs({ input: '/in.mov' }), /output/);
    assert.throws(() => ffmpegArgs({ input: '', output: '/out.mp4' }), /input/);
  });
});

describe('shouldProxy', () => {
  const big = { kind: 'video', storage: 's3', size: PROXY_MIN_BYTES };

  test('a large stored video qualifies', () => {
    assert.equal(shouldProxy(big), true);
  });

  test('a small one does not — a proxy would cost storage for nothing', () => {
    assert.equal(shouldProxy({ ...big, size: PROXY_MIN_BYTES - 1 }), false);
  });

  test('only video, and only from a bucket', () => {
    assert.equal(shouldProxy({ ...big, kind: 'image' }), false);
    assert.equal(shouldProxy({ ...big, kind: 'audio' }), false);
    assert.equal(shouldProxy({ ...big, storage: 'blob' }), false);
  });

  test('nonsense is false, not a thrown error on the upload path', () => {
    for (const bad of [null, undefined, {}, { kind: 'video' }]) {
      assert.equal(shouldProxy(bad), false, JSON.stringify(bad));
    }
  });
});

describe('isProxyKey', () => {
  const UUID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';

  test('accepts only what the server would have named', () => {
    assert.equal(isProxyKey(`_thumbs/${UUID}.proxy.mp4`), true);
    for (const bad of [
      `files/${UUID}.proxy.mp4`, `_thumbs/${UUID}.mp4`, `_thumbs/${UUID}.proxy.mov`,
      `_thumbs/${UUID}.strip.webp`, '_thumbs/notauuid.proxy.mp4', null, 7,
    ]) {
      assert.equal(isProxyKey(bad), false, JSON.stringify(bad));
    }
  });
});

describe('isStale', () => {
  test('a proxy of replaced content is stale', () => {
    // It plays, and shows the wrong footage — worse than having none.
    assert.equal(isStale({ status: 'done', sourceKey: 'files/old.mov' }, { storageKey: 'files/new.mov' }), true);
  });

  test('a proxy of the current content is not', () => {
    assert.equal(isStale({ status: 'done', sourceKey: 'files/a.mov' }, { storageKey: 'files/a.mov' }), false);
  });

  test('an unfinished job is never stale', () => {
    for (const status of ['queued', 'working', 'failed']) {
      assert.equal(isStale({ status, sourceKey: 'a' }, { storageKey: 'b' }), false, status);
    }
  });

  test('missing keys do not make it stale by accident', () => {
    assert.equal(isStale({ status: 'done', sourceKey: null }, { storageKey: 'a' }), false);
    assert.equal(isStale({ status: 'done', sourceKey: 'a' }, {}), false);
    assert.equal(isStale(null, { storageKey: 'a' }), false);
  });
});

describe('proxyJson', () => {
  test('no job reads as none', () => {
    assert.deepEqual(proxyJson(null), { status: 'none' });
  });

  test('it never exposes who claimed the job', () => {
    // A shared library would otherwise leak which account is running what.
    const out = proxyJson({
      status: 'working', progress: 0.4, claimedBy: 'someone@example.com',
      claimedDevice: "Ricky's MacBook Pro", sourceKey: 'files/a.mov',
    });
    assert.equal(out.device, "Ricky's MacBook Pro");
    assert.equal(JSON.stringify(out).includes('someone@example.com'), false);
    assert.equal('claimedBy' in out, false);
    assert.equal('sourceKey' in out, false, 'an internal key is not a client concern');
  });
});

describe('the lease', () => {
  test('is renewable rather than long', () => {
    // A long transcode is not a reason to lengthen this; it is a reason to
    // report progress, which renews it.
    assert.equal(LEASE_SECONDS, 600);
  });
});

// ── The server half ─────────────────────────────────────────────────────────
//
// Read from the source rather than executed, the same way test/transcripts.js
// pins its queue: these routes reach lib/db.js, so importing them here would
// mean a database. What they pin is the shape a mistake would quietly change —
// an authorization step dropped, a key taken from the request, a queue that
// forgot whose drives it was reading.

const { readFile } = await import('node:fs/promises');
const src = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');

describe('the key belongs to the server', () => {
  test('the claim names it from a uuid, and records it on the job', async () => {
    const claim = await src('app/api/files/[id]/proxy/claim/route.js');
    assert.match(claim, /proxyKeyFor\(randomUUID\(\)\)/, 'the key is minted here, not sent');
    assert.match(claim, /claimProxy\(g\.file\.id, \{[\s\S]*?proxyKey,/);
    // Signed for the key the CLAIM recorded — job.proxyKey — not the local one,
    // so a claim that lost the race cannot hand out a URL for its own key.
    assert.match(claim, /s3PresignProxyPut\(cfg, job\.proxyKey/);
  });

  test('PUT takes no key at all', async () => {
    const route = await src('app/api/files/[id]/proxy/route.js');
    const put = route.slice(route.indexOf('export async function PUT'));
    assert.doesNotMatch(put, /proxyKey/, 'a worker must not be able to name the object');
    assert.match(put, /finishProxy\(g\.file\.id, \{ email: g\.email, \.\.\.facts \}\)/);
  });

  test('…and finishProxy has no key parameter to give it', async () => {
    const db = await src('lib/db.js');
    const fn = db.slice(db.indexOf('export async function finishProxy'), db.indexOf('/** The claimer’s run failed'));
    assert.doesNotMatch(fn.split('\n')[0], /proxyKey/);
    assert.match(fn, /status = 'working' AND claimed_by = \$\{email\}/, 'only the claimer may finish it');
  });

  test('only a proxy key can be signed for writing', async () => {
    const storage = await src('lib/storage.js');
    const fn = storage.slice(storage.indexOf('export async function s3PresignProxyPut'));
    assert.match(fn.slice(0, 200), /if \(!isProxyKey\(key\)\) throw/);
  });
});

describe('every proxy route authorizes the same way', () => {
  test('the guard is the only way in', async () => {
    for (const p of [
      'app/api/files/[id]/proxy/route.js',
      'app/api/files/[id]/proxy/claim/route.js',
    ]) {
      const route = await src(p);
      const handlers = [...route.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
      assert.ok(handlers.length, `${p} declares no handlers`);
      for (const h of handlers) {
        const body = route.slice(route.indexOf(`export async function ${h}`));
        const upTo = body.slice(0, body.indexOf('\n}\n') + 1);
        assert.match(upTo, /await openProxy\(req, params\.id, '[a-z]+'\)/, `${p} ${h} does not open through the guard`);
        assert.match(upTo, /if \(g\.error\) return g\.error;/, `${p} ${h} does not return the guard's refusal`);
      }
    }
  });

  test('the guard checks the flag, then access, then the write rule', async () => {
    const guard = await src('lib/proxy-guard.js');
    assert.match(guard, /isFeatureEnabled\(principal\.flags, 'proxies'\)/);
    // The flag before any lookup: off, the file is never read, so a turned-off
    // feature cannot be used to probe which ids exist.
    // The CALL, not the import at the top of the file — which is what a
    // naive indexOf('getFileById') would find, and would pass whatever the
    // order of the body.
    assert.ok(
      guard.indexOf("isFeatureEnabled(principal.flags, 'proxies')") < guard.indexOf('await getFileById('),
      'the flag is read after the file',
    );
    assert.match(guard, /await canAccessFile\(file, principal\)/);
    assert.match(guard, /await canModifyFile\(file, principal\)/);
    assert.match(guard, /proxyDecision\(action, \{ flagOn, live, canRead, edit, canModify, kind \}\)/);
  });

  test('the queue reads through the listing’s access clause and then the write rule', async () => {
    const db = await src('lib/db.js');
    const fn = db.slice(db.indexOf('export async function listProxyJobs'), db.indexOf('async function deleteProxyRow'));
    assert.match(fn, /buildProxyQueueQuery\(\{ principal/);
    assert.match(fn, /modifiableFileIds\(files, principal\)/);
    assert.match(fn, /isProxyableKind\(effectiveKind\(file\)\)/);
    // A principal is required, not defaulted: an omitted one would read as
    // "no grants" in some paths and "everything" in others.
    assert.match(fn, /if \(!principal\) throw/);
  });
});

describe('the claim is atomic, and the lease is the contract’s ten minutes', () => {
  test('one UPDATE … WHERE … RETURNING, on a queued or expired row only', async () => {
    const db = await src('lib/db.js');
    const fn = db.slice(db.indexOf('export async function claimProxy'), db.indexOf('export async function reportProxyProgress'));
    assert.match(fn, /UPDATE proxies SET/);
    assert.match(fn, /status = 'queued' OR \(status = 'working' AND \(lease_until IS NULL OR lease_until < now\(\)\)\)/);
    assert.match(fn, /interval '10 minutes'/);
    // A trashed file is not claimable: the worker would download a file nobody
    // may see any more.
    assert.match(fn, /EXISTS \(SELECT 1 FROM files f WHERE f\.id = \$\{fileId\} AND f\.deleted_at IS NULL\)/);
    assert.equal(LEASE_SECONDS, 600);
  });

  test('a progress report renews the lease, and only the claimer’s', async () => {
    const db = await src('lib/db.js');
    const fn = db.slice(db.indexOf('export async function reportProxyProgress'), db.indexOf('export async function finishProxy'));
    assert.match(fn, /lease_until = now\(\) \+ interval '10 minutes'/);
    assert.match(fn, /status = 'working' AND claimed_by = \$\{email\}/);
  });
});

describe('a stale proxy is never served', () => {
  test('attachProxies withholds the key and says so', async () => {
    const db = await src('lib/db.js');
    const fn = db.slice(db.indexOf('export async function attachProxies'), db.indexOf('/**\n * Ask for a proxy.'));
    assert.match(fn, /proxyKey: row\.status === 'done' && !stale \? row\.proxyKey : null/);
    assert.match(fn, /proxyStale: stale/);
  });

  test('presignFileUrls signs a proxy only for a proxy key', async () => {
    const storage = await src('lib/storage.js');
    assert.match(storage, /if \(f\.proxyKey && isProxyKey\(f\.proxyKey\)\) \{/);
  });
});

describe('the player and the queue agree on the words', () => {
  test('the statuses the player tests for are statuses that exist', async () => {
    const player = await src('app/components/video/VideoPlayer.js');
    const tested = [...player.matchAll(/proxyStatus === '([a-z]+)'/g)].map((m) => m[1]);
    assert.ok(tested.length, 'the player no longer reads the proxy status');
    // 'none' is proxyJson's answer for a file with no job — a status the player
    // can legitimately see, alongside the four a row can hold.
    const real = [...PROXY_STATUSES, 'none'];
    for (const status of tested) {
      assert.ok(real.includes(status), `the player tests for "${status}", which is not a proxy status`);
    }
  });

  test('the player reads the live job before the server-rendered row', async () => {
    const player = await src('app/components/video/VideoPlayer.js');
    // A transcode that finishes while the page is open has to be picked up
    // without a reload, so the hook's url wins — and a stale rendition loses to
    // the master whichever of the two it came from.
    assert.match(player, /const proxy = \(row && !row\.stale \? row\.url : null\) \|\| file\?\.proxyUrl \|\| null;/);
    assert.match(player, /const proxyStatus = row\?\.status \|\| file\?\.proxyStatus \|\| null;/);
  });
});

describe('a heavy upload is queued without being able to fail the upload', () => {
  test('the queue write is awaited, caught, and after the row exists', async () => {
    const route = await src('app/api/files/route.js');
    const i = route.indexOf('requestProxy(file.id');
    assert.ok(i > route.indexOf('const file = await createFile('), 'queued before the row exists');
    assert.ok(i < route.indexOf('const [signed] = await presignFileUrls([file]);'), 'queued after the answer is built');
    assert.match(route.slice(i, i + 220), /\.catch\(\(e\) => console\.warn/, 'a failed queue write would fail the upload');
    assert.match(route, /isFeatureEnabled\(principal\.flags, 'proxies'\) && shouldProxy\(file\)/);
  });
});

describe('the bearer paths are outside the cookie gate', () => {
  test('the middleware matcher excludes both, or a Mac gets a 302 to /signin', async () => {
    const mw = await src('middleware.js');
    assert.match(mw, /api\/files\/\[\^\/\]\+\/proxy/);
    assert.match(mw, /\|api\/proxies\|/);
  });
});

describe('a rendition is never left in the bucket by accident', () => {
  test('both purge paths read the key before the row goes', async () => {
    for (const [p, before] of [
      ['lib/maintenance.js', 'await deleteFile(row.id)'],
      ['app/api/files/[id]/route.js', 'await deleteFile(id)'],
    ]) {
      const code = await src(p);
      const read = code.indexOf('proxyKeysFor(');
      assert.ok(read > 0, `${p} never asks for the proxy key`);
      assert.ok(read < code.indexOf(before), `${p} asks after the row is gone, when the key no longer exists`);
      // That the keys reach the GC — not which cfg goes with them. The second
      // argument is the bucket to delete from, and it moves: a drive in a bucket
      // of its own made it `{ cfg: base }` on one of these paths. Pinning the
      // literal made this test fail on a correct merge, which is the opposite of
      // its job.
      assert.match(code, /dropUnusedPreviews\(\{ \.\.\.previewKeysOf\((?:file|row)\), proxyKeys \}/, `${p} does not hand them to the GC`);
    }
  });

  test('the GC only ever deletes a server-named key', async () => {
    const gc = await src('lib/preview-gc.js');
    assert.match(gc, /proxyKeys\.filter\(isProxyKey\)/);
    // Fails closed: a check it could not make deletes nothing.
    assert.match(gc, /catch \{ proxies = \[\]; \}/);
  });

  test('the route removes the object it stopped pointing at', async () => {
    const route = await src('app/api/files/[id]/proxy/route.js');
    const del = route.slice(route.indexOf('export async function DELETE'));
    // The row first: a bucket that cannot be reached must leave an orphan, not a
    // `done` proxy whose URL 404s in the middle of playback.
    assert.ok(del.indexOf('deleteProxy(') < del.indexOf('dropProxyObject('), 'the object goes before the row');
    const post = route.slice(route.indexOf('export async function POST'), route.indexOf('export async function DELETE'));
    assert.match(post, /dropProxyObject\(row\?\.abandonedKey\)/);
    const guard = await src('lib/proxy-guard.js');
    assert.match(guard, /if \(!isProxyKey\(key\)\) return false;/);
  });
});

describe('the shared job primitives keep this queue’s own words', () => {
  test('a silent failure does not say "Transcription failed."', async () => {
    const { failureMessage, MAX_ERROR_CHARS } = await import('../lib/proxies.js');
    // The two queues share the function; they must not share the fallback. A
    // video whose transcode died saying nothing must not be reported as a
    // transcription problem.
    assert.equal(failureMessage(''), 'Making a streamable version failed.');
    assert.equal(failureMessage(null), 'Making a streamable version failed.');
    assert.equal(failureMessage({}), 'Making a streamable version failed.');
    assert.equal(failureMessage('ffmpeg: Unknown encoder'), 'ffmpeg: Unknown encoder');
    assert.equal(failureMessage('x'.repeat(900)).length, MAX_ERROR_CHARS);
  });

  test('and the transcript queue keeps its own', async () => {
    const { failureMessage } = await import('../lib/transcripts.js');
    assert.equal(failureMessage(''), 'Transcription failed.');
  });
});
