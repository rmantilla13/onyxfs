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
  proxySpec, ffmpegArgs, keyframeInterval, shouldProxy, asksAtUpload, wantedForCodec, playsInEveryBrowser, isProxyKey, isStale, proxyJson,
  PROXY_MAX_HEIGHT, PROXY_MIN_BYTES, PROXY_MIME, LEASE_SECONDS, PROXY_STATUSES, PROXY_KEYFRAME_SECONDS,
  EVERY_BROWSER_CODECS,
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

  test('it says how far apart the key frames are, so a worker need not', () => {
    // The Mac reads this from its claim (OnyxKit ProxySpec) rather than
    // keeping its own two seconds.
    assert.equal(proxySpec({ height: 2160 }).keyframeSeconds, PROXY_KEYFRAME_SECONDS);
    assert.equal(proxySpec().keyframeSeconds, PROXY_KEYFRAME_SECONDS);
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

  test('a key frame every two seconds at the source\'s rate, and none at a cut', () => {
    // x264 left to itself puts them 250 frames apart and adds one at every
    // scene cut: a seek decodes from up to ten seconds back. The Mac's
    // rendition keys every 2 s (ProxyTranscoder); this one must match it.
    assert.equal(PROXY_KEYFRAME_SECONDS, 2);
    const at = (sourceFps) => ffmpegArgs({ input: '/in.mov', output: '/out.mp4', sourceHeight: 2160, sourceFps });
    for (const [fps, gop] of [
      [{ num: 24000, den: 1001 }, '48'], [{ num: 24, den: 1 }, '48'], [{ num: 25, den: 1 }, '50'],
      [{ num: 30000, den: 1001 }, '60'], [{ num: 60000, den: 1001 }, '120'], [50, '100'], [120, '240'],
    ]) {
      const a = at(fps);
      assert.equal(flag(a, '-g'), gop, JSON.stringify(fps));
      assert.equal(flag(a, '-keyint_min'), gop, JSON.stringify(fps));
      assert.equal(flag(a, '-sc_threshold'), '0', JSON.stringify(fps));
    }
  });

  test('an unknown or nonsense rate still gets a GOP, counted at 30', () => {
    for (const fps of [undefined, null, {}, { num: 0, den: 1 }, { num: 24, den: 0 }, 'fast', -5, 0.5, 5000, NaN]) {
      assert.equal(flag(ffmpegArgs({ input: '/in.mov', output: '/out.mp4', sourceFps: fps }), '-g'), '60', JSON.stringify(fps));
    }
    assert.equal(keyframeInterval(), 60);
    assert.equal(keyframeInterval(1), 2, 'one a second at the slowest rate kept');
  });

  test('the GOP is the spec\'s seconds, counted at the source\'s rate', () => {
    const spec = { ...proxySpec({ height: 1080 }), keyframeSeconds: 1 };
    const at = (sourceFps, s = spec) => flag(ffmpegArgs({ input: '/in.mov', output: '/out.mp4', spec: s, sourceFps }), '-g');
    assert.equal(at({ num: 30000, den: 1001 }), '30');
    assert.equal(at(null), '30', 'counted at 30 when the rate is not known');
    for (const odd of [0, -1, 'x', null, 3600]) {
      assert.equal(at(25, { ...spec, keyframeSeconds: odd }), '50', `${odd}: the default two seconds`);
    }
    assert.equal(keyframeInterval(24, 0.5), 12);
  });

  test('the GOP flags are encoder options, before the output', () => {
    const a = ffmpegArgs({ input: '/in.mov', output: '/out.mp4', sourceFps: { num: 25, den: 1 } });
    assert.ok(a.indexOf('-g') > a.indexOf('-c:v'), 'after the codec is chosen');
    assert.ok(a.indexOf('-sc_threshold') < a.length - 1);
    assert.equal(a[a.length - 1], '/out.mp4');
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
    for (const bad of [null, undefined, {}, { kind: 'video' }, { kind: 'video', storage: 's3', metadata: null }]) {
      assert.equal(shouldProxy(bad), false, JSON.stringify(bad));
    }
  });
});

// What a video is encoded with decides as much as its size: a 150 MB ProRes or
// 10-bit HEVC clip streams well enough, and plays in no browser but Safari.
describe('shouldProxy by codec', () => {
  const MB = 1024 * 1024;
  const SIZES = [1 * MB, 150 * MB, PROXY_MIN_BYTES - 1, PROXY_MIN_BYTES, 40 * 1024 * MB];
  // [videoCodec, plays in every browser]
  const CODECS = [
    [undefined, null],                                                         // never probed: an old row
    [{ fourcc: 'avc1' }, true],                                                // H.264, nothing more said
    [{ fourcc: 'avc1', bitDepth: 8, chroma: '4:2:0', hdr: false }, true],
    [{ fourcc: 'avc3', bitDepth: 8, chroma: '4:2:0' }, true],
    [{ fourcc: 'avc1', bitDepth: 10, chroma: '4:2:0' }, false],                // High 10
    [{ fourcc: 'avc1', bitDepth: 10, chroma: '4:2:2' }, false],                // XAVC 4:2:2
    [{ fourcc: 'avc1', bitDepth: 8, chroma: '4:2:2' }, false],
    [{ fourcc: 'avc1', bitDepth: 8, chroma: '4:2:0', hdr: true }, false],      // HLG in H.264
    [{ fourcc: 'hvc1', bitDepth: 8, chroma: '4:2:0', hdr: false }, false],     // 8-bit SDR HEVC: see playsInEveryBrowser
    [{ fourcc: 'hvc1', bitDepth: 10, chroma: '4:2:0', hdr: true }, false],     // an iPhone's HDR
    [{ fourcc: 'hev1' }, false],
    [{ fourcc: 'dvh1', bitDepth: 10 }, false],                                 // Dolby Vision
    [{ fourcc: 'apcn' }, false], [{ fourcc: 'apch' }, false], [{ fourcc: 'ap4h' }, false], [{ fourcc: 'apco' }, false],
    [{ fourcc: 'AVdh' }, false],                                               // DNxHR
    [{ fourcc: 'av01', bitDepth: 8 }, false], [{ fourcc: 'vp09' }, false], [{ fourcc: 'mp4v' }, false],
  ];

  test('every size against every codec', () => {
    for (const size of SIZES) {
      for (const [videoCodec, plays] of CODECS) {
        const file = { kind: 'video', storage: 's3', size, metadata: videoCodec ? { videoCodec } : {} };
        const want = size >= PROXY_MIN_BYTES || plays === false;
        assert.equal(shouldProxy(file), want, `${size} bytes, ${JSON.stringify(videoCodec)}`);
        assert.equal(playsInEveryBrowser(videoCodec), plays, JSON.stringify(videoCodec));
      }
    }
  });

  test('only the size rule asks for one at upload; the codec\'s wait for the queue\'s offer', () => {
    // A job per phone clip in the asked-for queue, served oldest first, would
    // put a person's own request behind every clip uploaded before it.
    for (const size of SIZES) {
      for (const [videoCodec] of CODECS) {
        const file = { kind: 'video', storage: 's3', size, metadata: videoCodec ? { videoCodec } : {} };
        assert.equal(asksAtUpload(file), size >= PROXY_MIN_BYTES, `${size} bytes, ${JSON.stringify(videoCodec)}`);
      }
    }
    assert.equal(asksAtUpload({ kind: 'video', storage: 'blob', size: PROXY_MIN_BYTES }), false, 'nowhere to put it');
    assert.equal(asksAtUpload({ kind: 'image', storage: 's3', size: PROXY_MIN_BYTES }), false);
  });

  test('what is wanted for its codec alone is what the size rule leaves: a worker must say it takes those', () => {
    // A Mac from before ?codecs=1 copies HDR into eight bits still labelled
    // HDR, and on its battery; it is offered the rest, as it always was.
    for (const size of SIZES) {
      for (const [videoCodec, plays] of CODECS) {
        const file = { kind: 'video', storage: 's3', size, metadata: videoCodec ? { videoCodec } : {} };
        const want = size < PROXY_MIN_BYTES && plays === false;
        assert.equal(wantedForCodec(file), want, `${size} bytes, ${JSON.stringify(videoCodec)}`);
        assert.equal(shouldProxy(file), want || asksAtUpload(file), 'the two halves of the rule, and nothing between');
      }
    }
    const hdr = { metadata: { videoCodec: { fourcc: 'hvc1', bitDepth: 10, hdr: true } } };
    assert.equal(wantedForCodec({ ...hdr, kind: 'video', storage: 's3' }), true, 'a size not on record is not large');
    assert.equal(wantedForCodec({ ...hdr, kind: 'video', storage: 'blob', size: 150 * MB }), false, 'nowhere to put it');
    assert.equal(wantedForCodec({ ...hdr, kind: 'image', storage: 's3', size: 150 * MB }), false);
    assert.equal(wantedForCodec(null), false);
  });

  test('the queue and the claim hold such a video back from a worker that does not say ?codecs=1', async () => {
    const db = await src('lib/db.js');
    const fn = db.slice(db.indexOf('export async function listProxyJobs'), db.indexOf('export async function queueProxyIfMissing'));
    assert.match(fn.slice(0, fn.indexOf('buildProxyCandidateQuery(')), /if \(!codecs && wantedForCodec\(file\)\) return;/, 'asked for or not');
    const queue = await src('app/api/proxies/queue/route.js');
    assert.match(queue, /codecs: query\.get\('codecs'\) === '1'/);
    const claim = await src('app/api/files/[id]/proxy/claim/route.js');
    const check = claim.indexOf("wantedForCodec(g.file) && new URL(req.url).searchParams.get('codecs') !== '1'");
    assert.ok(check > 0, 'the claim reads it itself');
    assert.ok(check < claim.indexOf('let claimed = await claim()'), 'before anything is written');
  });

  test('an unknown codec keeps the size rule exactly as it was', () => {
    for (const metadata of [undefined, null, {}, { width: 3840 }, { videoCodec: null }, { videoCodec: {} },
      { videoCodec: { fourcc: '' } }, { videoCodec: { fourcc: 7 } }, { videoCodec: 'hvc1' }, { videoCodec: ['hvc1'] },
      { videoCodec: { bitDepth: 10, hdr: true } }]) {
      const small = { kind: 'video', storage: 's3', size: 150 * MB, metadata };
      assert.equal(shouldProxy(small), false, JSON.stringify(metadata));
      assert.equal(shouldProxy({ ...small, size: PROXY_MIN_BYTES }), true, JSON.stringify(metadata));
    }
  });

  test('the codec does not make a proxy of anything that cannot have one', () => {
    const hevc = { metadata: { videoCodec: { fourcc: 'hvc1', bitDepth: 10 } }, size: 150 * MB };
    assert.equal(shouldProxy({ ...hevc, kind: 'video', storage: 'blob' }), false, 'nowhere to put it');
    assert.equal(shouldProxy({ ...hevc, kind: 'image', storage: 's3' }), false);
    assert.equal(shouldProxy({ ...hevc, kind: 'audio', storage: 's3' }), false);
    // A row stored as 'other' is still a video by its name.
    assert.equal(shouldProxy({ ...hevc, kind: 'other', name: 'IMG_0042.MOV', storage: 's3' }), true);
  });

  test('H.264 is the only codec every browser plays', () => {
    assert.deepEqual([...EVERY_BROWSER_CODECS], ['avc1', 'avc3']);
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

  test('a clip light enough to stream loads its metadata at once; a heavy master waits for play', async () => {
    const player = await src('app/components/video/VideoPlayer.js');
    assert.match(player, /const heavy = !proxy && Number\(file\?\.size\) > HEAVY_BYTES;/);
    assert.match(player, /preload=\{started \|\| !heavy \? 'metadata' : 'none'\}/);
  });

  test('a video this browser cannot decode is offered a streamable version, whatever its size', async () => {
    // A file from before its codec was kept is in no queue: the browser that
    // fails to play it is the first to know, and an editor can ask there.
    const player = await src('app/components/video/VideoPlayer.js');
    assert.match(player, /if \(!proxy && \(code === 3 \|\| code === 4\)\) setUndecodable\(true\);/, 'a format error, not a lapsed link');
    assert.match(player, /if \(!e\.target\.videoWidth && !e\.target\.videoHeight && !proxy\) \{\s*setUndecodable\(true\);/, 'nor only the sound');
    assert.match(player, /\{!heavy && !proxy && undecodable && \(making \|\| job\?\.canRequest\) && \(/);
    assert.match(player, /useEffect\(\(\) => \{ setError\(null\); setUndecodable\(false\); \}, \[src\]\);/, 'tried afresh on the copy');
  });
});

// Where the server-rendered and listed rows are played: what signs the
// rendition is test/playback-links.test.js's (and its SQL proxies-db's); these
// are the two places a browser is handed it that no test can render.
describe('every player a row reaches prefers the rendition', () => {
  test('Quick Look plays the streamable copy the listing found', async () => {
    const ql = await src('app/components/quicklook/QuickLook.js');
    assert.match(ql, /className="ql-video"\s+src=\{file\.proxyUrl \|\| file\.url\}/);
  });

  test('the share page looks it up before it signs, under the flags the link was let in by', async () => {
    const page = await src('app/s/[token]/page.js');
    const lookup = page.indexOf('await playableProxies([access.file], access.flags)');
    const sign = page.indexOf('await presignFileUrls(withProxyKeys([access.file], proxies)');
    assert.ok(lookup > 0, 'the page no longer looks up the proxy');
    assert.ok(sign > lookup, 'signed before the key is there to sign');
    assert.ok(page.indexOf('sharedFile(signed)') > sign);
  });
});

describe('a heavy upload is queued without being able to fail the upload', () => {
  test('the queue write is awaited, caught, and after the row exists', async () => {
    const route = await src('app/api/files/route.js');
    const i = route.indexOf('requestProxy(file.id');
    assert.ok(i > route.indexOf('const file = await createFile('), 'queued before the row exists');
    assert.ok(i < route.indexOf('const [signed] = await presignFileUrls([file]);'), 'queued after the answer is built');
    assert.match(route.slice(i, i + 220), /\.catch\(\(e\) => console\.warn/, 'a failed queue write would fail the upload');
    // Asked for by size alone: one there for its codec waits for the queue's
    // offer, behind what people asked for (lib/proxies.js asksAtUpload).
    assert.match(route, /isFeatureEnabled\(principal\.flags, 'proxies'\) && asksAtUpload\(file\)/);
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
    // Renditions are the app's own, like previews: in the base bucket, whatever
    // drive the file is in. The route's `cfg` is the file's own drive
    // (storageForKey), so it hands the GC `base`; maintenance's `cfg` is the base.
    for (const [p, before, gc] of [
      ['lib/maintenance.js', 'await deleteFile(row.id)', /proxyKeys \}, \{ cfg \}\)/],
      ['app/api/files/[id]/route.js', 'await deleteFile(id)', /proxyKeys \}, \{ cfg: base \}\)/],
    ]) {
      const code = await src(p);
      const read = code.indexOf('proxyKeysFor(');
      assert.ok(read > 0, `${p} never asks for the proxy key`);
      assert.ok(read < code.indexOf(before), `${p} asks after the row is gone, when the key no longer exists`);
      assert.match(code, gc, `${p} does not hand them to the GC, in the base bucket`);
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

// Every large video is meant to have a streamable version, not only the ones
// uploaded since proxies were asked for at upload. The queue offers the rest
// once nothing someone asked for is waiting, and the claim makes their job.
describe('large videos with no job are offered, after everything asked for', () => {
  test('the candidates query: large, video, in storage, no job of any kind, through the access clause', async () => {
    const { buildProxyCandidateQuery } = await import('../lib/file-query.js');
    const { principalFrom } = await import('../lib/authz.js');
    const { DEFAULT_FLAGS } = await import('../lib/features.js');
    const p = principalFrom({
      email: 'm@x.test', person: { roleId: 'member' }, globalFlags: DEFAULT_FLAGS,
      grants: { drives: [{ id: 'd1', prefix: 'secret' }, { id: 'd2', prefix: 'team' }], roles: { d2: 'editor' } },
    });
    const q = buildProxyCandidateQuery({ principal: p, minBytes: PROXY_MIN_BYTES });
    assert.match(q.text, /f\.deleted_at IS NULL/);
    assert.match(q.text, /f\.storage = 's3'/);
    assert.match(q.text, /f\.size >= \$1/);
    assert.equal(q.params[0], PROXY_MIN_BYTES);
    // Done, failed or waiting, a job is left alone: a failure is not retried
    // by being offered again, and one someone asked for is in the queue proper.
    assert.match(q.text, /NOT EXISTS \(SELECT 1 FROM proxies j WHERE j\.file_id = f\.id\)/);
    assert.match(q.text, /f\.kind = 'video'/);
    assert.match(q.text, /LIKE ANY/, 'the drive boundary');
    assert.ok(q.params.some((v) => Array.isArray(v) && v.includes('secret/%')));
    assert.match(q.text, /ORDER BY f\.created_at DESC, f\.id DESC/, 'newest first');
    const admin = buildProxyCandidateQuery({ principal: { isAdmin: true }, minBytes: PROXY_MIN_BYTES });
    assert.doesNotMatch(admin.text, /LIKE ANY/);
  });

  test('with the codecs every browser plays, a smaller video some browser will not play is a candidate too', async () => {
    const { buildProxyCandidateQuery } = await import('../lib/file-query.js');
    const q = buildProxyCandidateQuery({ principal: { isAdmin: true }, minBytes: PROXY_MIN_BYTES, playable: EVERY_BROWSER_CODECS });
    assert.equal(q.params[0], PROXY_MIN_BYTES);
    assert.match(q.text, /\(f\.size >= \$1 OR \(jsonb_typeof\(f\.metadata -> 'videoCodec' -> 'fourcc'\) = 'string' AND/);
    assert.match(q.text, /<> ALL\(\$2::text\[\]\)/);
    assert.deepEqual(q.params[1], ['avc1', 'avc3']);
    // playsInEveryBrowser's other three, as SQL.
    assert.match(q.text, /-> 'bitDepth'\) > '8'::jsonb/);
    assert.match(q.text, /coalesce\(f\.metadata -> 'videoCodec' ->> 'chroma', '4:2:0'\) <> '4:2:0'/);
    assert.match(q.text, /-> 'hdr'\) = 'true'::jsonb/);
    // Without them, the size alone, as before.
    const bare = buildProxyCandidateQuery({ principal: { isAdmin: true }, minBytes: PROXY_MIN_BYTES });
    assert.doesNotMatch(bare.text, /videoCodec/);
    assert.match(bare.text, /AND f\.size >= \$1\n/);
    assert.doesNotMatch(buildProxyCandidateQuery({ principal: { isAdmin: true }, minBytes: 1, playable: [] }).text, /videoCodec/);
  });

  test('only rows in drives the caller may change things in: a drive they view does not fill the pages', async () => {
    const { buildProxyCandidateQuery } = await import('../lib/file-query.js');
    const { principalFrom } = await import('../lib/authz.js');
    const { DEFAULT_FLAGS } = await import('../lib/features.js');
    const drives = [{ id: 'd1', prefix: 'secret' }, { id: 'd2', prefix: 'team' }, { id: 'd3', prefix: 'phones' }];
    const member = (roles) => principalFrom({
      email: 'm@x.test', person: { roleId: 'member' }, globalFlags: DEFAULT_FLAGS, grants: { drives, roles },
    });
    const q = buildProxyCandidateQuery({ principal: member({ d2: 'editor', d3: 'viewer' }), minBytes: PROXY_MIN_BYTES });
    // The write patterns after the access clause's own: team, not phones.
    assert.ok(q.params.some((v) => Array.isArray(v) && v.length === 1 && v[0] === 'team/%'), JSON.stringify(q.params));
    assert.ok(!q.params.some((v) => Array.isArray(v) && v.length === 1 && v[0] === 'phones/%'));
    assert.match(q.text, /a\.access IN \('editor', 'owner'\)/, 'or a file shared with them to edit');
    // A viewer of every drive they are in: rows outside drives, or shared to edit.
    const viewer = buildProxyCandidateQuery({ principal: member({ d2: 'viewer' }), minBytes: PROXY_MIN_BYTES });
    assert.match(viewer.text, /a\.access IN \('editor', 'owner'\)/);
    assert.equal(viewer.text.match(/LIKE ANY/g).length, 3, 'the access clause’s two, and the write rule’s NOT');
    // Nothing for an admin, nor for a principal with no write patterns worked
    // out — missing them must not hide a row.
    assert.doesNotMatch(buildProxyCandidateQuery({ principal: { isAdmin: true }, minBytes: 1 }).text, /a\.access IN/);
    const handMade = { email: 'm@x.test', drivePatterns: { all: ['team/%'], mine: ['team/%'] } };
    assert.doesNotMatch(buildProxyCandidateQuery({ principal: handMade, minBytes: 1 }).text, /a\.access IN/);
  });

  test('pages on (created_at, id), and will not run without a size floor', async () => {
    const { buildProxyCandidateQuery } = await import('../lib/file-query.js');
    const q = buildProxyCandidateQuery({ principal: { isAdmin: true }, minBytes: PROXY_MIN_BYTES, after: { createdAt: 1790000000000, id: 'f9' } });
    assert.match(q.text, /\(f\.created_at, f\.id\) < \(\$\d+::bigint, \$\d+::text\)/);
    assert.ok(q.params.includes(1790000000000) && q.params.includes('f9'));
    assert.throws(() => buildProxyCandidateQuery({ principal: { isAdmin: true } }), /minBytes/);
  });

  test('lib/db.js offers them only after the jobs asked for, through the write rule and shouldProxy', async () => {
    const db = await src('lib/db.js');
    const fn = db.slice(db.indexOf('export async function listProxyJobs'), db.indexOf('export async function queueProxyIfMissing'));
    const asked = fn.indexOf('buildProxyQueueQuery(');
    const offered = fn.indexOf('buildProxyCandidateQuery(');
    assert.ok(asked > 0 && offered > asked, 'what someone asked for comes first');
    // The codec widens the size rule, for a worker that takes such videos
    // (?codecs=1) — except a Mac saving power, which asks for the large alone.
    assert.match(fn.slice(offered), /minBytes: PROXY_MIN_BYTES, playable: codecs && !large \? EVERY_BROWSER_CODECS : null/);
    assert.match(fn.slice(0, offered), /if \(large && file\.size != null && Number\(file\.size\) < PROXY_MIN_BYTES\) return;/);
    assert.match(fn.slice(offered), /modifiableFileIds\(files, principal\)/);
    assert.match(fn.slice(offered), /mine\.has\(file\.id\) && shouldProxy\(file\)/);
    assert.match(fn.slice(offered), /requestedAt: null/);
  });

  test('a job is made only where there is none, and never over one', async () => {
    const db = await src('lib/db.js');
    const fn = db.slice(db.indexOf('export async function queueProxyIfMissing'));
    assert.match(fn.slice(0, 800), /ON CONFLICT \(file_id\) DO NOTHING/);
  });

  test('the claim makes it, after the guard, and only for a video that should have one', async () => {
    const route = await src('app/api/files/[id]/proxy/claim/route.js');
    const guard = route.indexOf("await openProxy(req, params.id, 'claim')");
    const made = route.indexOf('await queueProxyIfMissing(g.file.id)');
    assert.ok(guard > 0 && made > guard, 'the checks come first');
    assert.match(route, /if \(claimed\.missing && shouldProxy\(g\.file\)\) \{\s*await queueProxyIfMissing\(g\.file\.id\);\s*claimed = await claim\(\);/);
  });
});
