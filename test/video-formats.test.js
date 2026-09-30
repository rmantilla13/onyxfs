// A video's "Download as…" copies (lib/video-formats.js): which sizes it is
// offered, when its proxy is the copy, the codec string and bitrate each
// copy is made with, how big and how long, where it is held, what the
// browser's answers rule out — and the sinks it is written into
// (lib/video-convert.js).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIDEO_TARGETS, videoTarget, shortEdge, videoTargetSize, videoTargets, h264Level, h264CodecString, videoBitrate,
  videoEncoderConfig, audioEncodeConfig, audioPlan, estimateBytes, estimateSeconds, outputPlace, sourceRead,
  videoPlan, videoChoices, proxyShortEdge, hasVideoTargets, etaSeconds, fmtMinutes, videoRowDetail, videoReasonText,
  MEMORY_MAX_BYTES, ESTIMATE_MARGIN, WHOLE_READ_MAX_BYTES, VIDEO_BITRATES, KEYFRAME_SECONDS, MIN_BITRATE_SHARE, H264_MODES,
} from '../lib/video-formats.js';
import { downloadChoices, offersDownloadAs, videoDownloadName, proxyDownloadName } from '../lib/download-formats.js';
import { memorySink, fileSink } from '../lib/video-convert.js';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const ids = (list) => list.map((x) => x.id);

/** What lib/video-convert.js's probe answers for a source, with everything this browser can do. */
function probeOf(video = {}, { audio = { codec: 'aac', channels: 2, sampleRate: 48000, bitrate: 128000, decode: true }, aac = null, encode = null, h264 = { profile: 'high', latencyMode: 'quality' } } = {}) {
  const v = { codec: 'avc', width: 3840, height: 2160, rotation: 0, hdr: false, decode: true, fps: 30, frameRate: 30, duration: 60, bitrate: null, ...video };
  const enc = {};
  for (const t of VIDEO_TARGETS) {
    const c = videoEncoderConfig(v, t.id, { profile: h264?.profile });
    if (c) enc[t.id] = encode && t.id in encode ? encode[t.id] : h264 ? c.codec : false;
  }
  return { ok: true, read: 'range', bytes: null, video: v, audio, encode: enc, h264, aac };
}
const clip = (extra = {}) => ({
  id: 'v1', name: 'Clip.mov', mime: 'video/quicktime', kind: 'video', size: 400 * MB,
  url: 'https://s3.test/onyx/team/Clip.mov?X-Amz-Signature=x', metadata: { width: 3840, height: 2160, duration: 60 }, ...extra,
});

describe('which sizes a video gets', () => {
  test('"p" is the short edge; only sizes at or below it — never upscaled', () => {
    assert.deepEqual(ids(videoTargets({ width: 3840, height: 2160 })), ['2160p', '1080p', '720p']);
    assert.deepEqual(ids(videoTargets({ width: 1920, height: 1080 })), ['1080p', '720p']);
    assert.deepEqual(ids(videoTargets({ width: 1280, height: 720 })), ['720p'], 'a 720p source: 720p alone');
    assert.deepEqual(ids(videoTargets({ width: 1279, height: 719 })), [], 'just under 720: nothing');
    assert.deepEqual(ids(videoTargets({ width: 640, height: 360 })), []);
    assert.deepEqual(ids(videoTargets({ width: 1440, height: 1080 })), ['1080p', '720p'], '4:3 HDV is 1080p');
  });

  test('a portrait clip is sized by its short edge: 1080 × 1920 is 1080p, and 720p is 720 wide', () => {
    const phone = { width: 1080, height: 1920 };
    assert.equal(shortEdge(phone), 1080);
    assert.deepEqual(videoTargets(phone).map((t) => [t.id, t.width, t.height]), [['1080p', 1080, 1920], ['720p', 720, 1280]]);
    assert.deepEqual(videoTargets({ width: 2160, height: 3840 }).map((t) => [t.id, t.width, t.height]), [
      ['2160p', 2160, 3840], ['1080p', 1080, 1920], ['720p', 720, 1280],
    ]);
  });

  test('4K only from a source at least 2160 on its short side — a wide 4K scope is not', () => {
    assert.ok(ids(videoTargets({ width: 4096, height: 2160 })).includes('2160p'), 'DCI 4K');
    assert.ok(!ids(videoTargets({ width: 3840, height: 1608 })).includes('2160p'), '2.39:1 from a 4K camera: 1608 lines');
    assert.ok(!ids(videoTargets({ width: 2560, height: 1440 })).includes('2160p'));
    assert.deepEqual(videoTargets({ width: 3840, height: 1608 }).map((t) => [t.id, t.width, t.height]), [['1080p', 2580, 1080], ['720p', 1720, 720]]);
  });

  test('the aspect is kept and both sides are even, as H.264 4:2:0 needs', () => {
    assert.deepEqual(videoTargetSize({ width: 3840, height: 2160 }, 1080), { width: 1920, height: 1080 });
    assert.deepEqual(videoTargetSize({ width: 4096, height: 2160 }, 1080), { width: 2048, height: 1080 });
    assert.deepEqual(videoTargetSize({ width: 1920, height: 1080 }, 720), { width: 1280, height: 720 });
    assert.deepEqual(videoTargetSize({ width: 1920, height: 1080 }, 1080), { width: 1920, height: 1080 }, 'at its own size, as it is');
    assert.deepEqual(videoTargetSize({ width: 1281, height: 721 }, 720), { width: 1280, height: 720 }, 'the nearest even');
    assert.deepEqual(videoTargetSize({ width: 1279, height: 720 }, 720), { width: 1280, height: 720 });
    assert.deepEqual(videoTargetSize({ width: 800, height: 600 }, 1080), { width: 800, height: 600 }, 'never larger');
    assert.equal(videoTargetSize({ width: 0, height: 10 }, 720), null);
    assert.equal(videoTargetSize(null, 720), null);
  });

  test('with no size on record every size is offered, sizes unknown: the probe decides', () => {
    const all = videoTargets({});
    assert.deepEqual(ids(all), ['2160p', '1080p', '720p']);
    assert.ok(all.every((t) => t.width === null && t.height === null));
    assert.ok(hasVideoTargets(clip({ metadata: {} })));
    assert.ok(!hasVideoTargets(clip({ metadata: { width: 640, height: 360 } })));
  });
});

describe('the codec string each copy is made with', () => {
  test('H.264 High, its level from the frame’s size and rate (table A-1)', () => {
    const at = (w, h, fps, short) => h264CodecString(h264Level({ width: w, height: h, fps, bitrate: videoBitrate({ short, fps }) }));
    assert.equal(at(1280, 720, 30, 720), 'avc1.64001F', '720p30: 3.1');
    assert.equal(at(1280, 720, 60, 720), 'avc1.640020', '720p60: 3.2');
    assert.equal(at(1920, 1080, 30, 1080), 'avc1.640028', '1080p30: 4.0');
    assert.equal(at(1920, 1080, 29.97, 1080), 'avc1.640028', '29.97 still fits 4.0');
    assert.equal(at(1920, 1080, 60, 1080), 'avc1.64002A', '1080p60: 4.2');
    assert.equal(at(3840, 2160, 30, 2160), 'avc1.640033', '4K30: 5.1 — 5.0 cannot hold 4K');
    assert.equal(at(3840, 2160, 60, 2160), 'avc1.640034', '4K60: 5.2');
    assert.equal(at(1080, 1920, 30, 1080), 'avc1.640028', 'portrait 1080p: the same level');
    assert.equal(at(2160, 3840, 30, 2160), 'avc1.640033', 'portrait 4K');
    assert.equal(at(2580, 1080, 30, 1080), 'avc1.640032', 'a scope 1080p: 5.0');
  });

  test('nothing past 5.2 — as far as Safari and QuickTime go — so no such copy is offered', () => {
    assert.equal(h264Level({ width: 3840, height: 2160, fps: 120, bitrate: 60e6 }), null, '4K120');
    assert.equal(h264Level({ width: 7680, height: 2160, fps: 30, bitrate: 40e6 }), null, 'a panorama');
    assert.equal(videoEncoderConfig({ width: 3840, height: 2160, fps: 120 }, '2160p'), null);
    assert.equal(videoPlan(probeOf({ fps: 120, frameRate: 120 }), '2160p').reason, 'level');
    assert.equal(h264Level({ width: 1920, height: 1080, fps: 240, bitrate: 12e6 }), 52, '1080p240 still fits');
  });

  test('the level’s bitrate ceiling counts: a starved level is passed over', () => {
    assert.equal(h264Level({ width: 1280, height: 720, fps: 30, bitrate: 5e6 }), 31);
    assert.equal(h264Level({ width: 1280, height: 720, fps: 30, bitrate: 15e6 }), 32, 'past 3.1’s 17.5 Mb/s at peak');
    assert.equal(h264CodecString(31), 'avc1.64001F');
    assert.equal(h264CodecString(0), null);
    assert.equal(h264Level({ width: 0, height: 0 }), null);
  });

  test('the encoder is asked exactly what the copy will use', () => {
    assert.deepEqual(videoEncoderConfig({ width: 3840, height: 2160, fps: 30 }, '1080p'), {
      codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 8e6, framerate: 30,
    });
    assert.equal(videoEncoderConfig({ width: 1920, height: 1080, fps: 30 }, '2160p'), null, 'never upscaled');
    assert.equal(videoEncoderConfig({ width: 1920, height: 1080 }, '1080p').framerate, 30, 'no rate: 30 assumed');
    assert.equal(videoEncoderConfig({ width: 1920, height: 1080 }, 'nope'), null);
  });
});

describe('bitrate', () => {
  test('YouTube’s upload rates for SDR H.264, by size and frame rate', () => {
    assert.equal(videoBitrate({ short: 2160, fps: 30 }), 40e6);
    assert.equal(videoBitrate({ short: 2160, fps: 60 }), 60e6);
    assert.equal(videoBitrate({ short: 1080, fps: 24 }), 8e6);
    assert.equal(videoBitrate({ short: 1080, fps: 50 }), 12e6);
    assert.equal(videoBitrate({ short: 720, fps: 30 }), 5e6);
    assert.equal(videoBitrate({ short: 720, fps: 59.94 }), 7.5e6);
    assert.equal(videoBitrate({ short: 1080, fps: 120 }), 24e6, 'past 60, in proportion');
    assert.equal(videoBitrate({ short: 1080 }), 8e6, 'no rate: 30 assumed');
    assert.equal(videoBitrate({ short: 480 }), null);
    assert.deepEqual(Object.keys(VIDEO_BITRATES).map(Number).sort((a, b) => a - b), [720, 1080, 2160]);
  });

  test('never more than the source spends — in H.264’s terms — nor starved below a quarter', () => {
    assert.equal(videoBitrate({ short: 1080, fps: 30, sourceBitrate: 20e6, sourceCodec: 'avc' }), 8e6, 'a rich source: the row');
    assert.equal(videoBitrate({ short: 1080, fps: 30, sourceBitrate: 4e6, sourceCodec: 'avc' }), 4e6, 'no bigger than an H.264 original');
    assert.equal(videoBitrate({ short: 1080, fps: 30, sourceBitrate: 4e6, sourceCodec: 'hevc' }), 6e6, 'HEVC needs half again in H.264');
    assert.equal(videoBitrate({ short: 2160, fps: 30, sourceBitrate: 24e6, sourceCodec: 'hevc' }), 36e6, 'an iPhone’s 4K HEVC');
    assert.equal(videoBitrate({ short: 1080, fps: 30, sourceBitrate: 0.5e6, sourceCodec: 'avc' }), 8e6 * MIN_BITRATE_SHARE);
    assert.equal(videoBitrate({ short: 720, fps: 30, sourceBitrate: 'x' }), 5e6, 'unknown: the row');
  });
});

describe('sound', () => {
  test('AAC in one or two channels is copied as it is', () => {
    assert.deepEqual(audioPlan({ codec: 'aac', channels: 2, sampleRate: 48000, bitrate: 256000 }), { mode: 'copy', bitrate: 256000 });
    assert.equal(audioPlan({ codec: 'aac', channels: 1, sampleRate: 44100 }).mode, 'copy');
    assert.deepEqual(audioPlan(null), { mode: 'none', bitrate: 0 }, 'no sound: none');
  });

  test('anything else is made AAC where this browser can — stereo at most, at 44.1 or 48 kHz', () => {
    assert.deepEqual(audioPlan({ codec: 'opus', channels: 2, sampleRate: 48000 }, { aacEncode: true }), {
      mode: 'encode', codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 48000, bitrate: 192000,
    });
    assert.deepEqual(audioEncodeConfig({ codec: 'pcm-s24', channels: 1, sampleRate: 44100 }), { codec: 'mp4a.40.2', numberOfChannels: 1, sampleRate: 44100, bitrate: 128000 });
    assert.equal(audioEncodeConfig({ codec: 'pcm-s24', channels: 2, sampleRate: 96000 }).sampleRate, 48000, '96 kHz is resampled');
    assert.equal(audioPlan({ codec: 'aac', channels: 6, sampleRate: 48000 }, { aacEncode: true }).numberOfChannels, 2, '5.1 made stereo');
  });

  test('where it cannot: no copy — except 5.1 AAC, which stays AAC as it is', () => {
    assert.equal(audioPlan({ codec: 'opus', channels: 2, sampleRate: 48000 }, { aacEncode: false }), null);
    assert.equal(audioPlan({ codec: 'pcm-s16', channels: 2, sampleRate: 48000 }), null);
    assert.equal(audioPlan({ codec: 'ac3', channels: 6, sampleRate: 48000, decode: false }, { aacEncode: true }), null, 'undecodable');
    assert.equal(audioPlan({ codec: 'aac', channels: 6, sampleRate: 48000 }, { aacEncode: false }).mode, 'copy');
  });
});

describe('how big, how long, and where it is held', () => {
  test('bytes: the duration at the video and audio rates, the MP4’s boxes on top', () => {
    assert.equal(estimateBytes({ duration: 600, videoBitrate: 8e6, audioBitrate: 192000 }), Math.round((600 * 8192000) / 8 * 1.01));
    assert.equal(estimateBytes({ duration: 0, videoBitrate: 8e6 }), null);
    assert.equal(estimateBytes({ videoBitrate: 8e6 }), null);
  });

  test('a ten-minute 4K clip is about 3 GB: too large to hold, written to disk where the browser can, else refused', () => {
    const plan = videoPlan(probeOf({ duration: 600 }), '2160p', { disk: false });
    assert.equal(plan.reason, 'size');
    assert.ok(plan.bytes > 2.9e9 && plan.bytes < 3.2e9, `${plan.bytes}`);
    assert.equal(videoPlan(probeOf({ duration: 600 }), '2160p', { disk: true }).place, 'disk');
    // Its 1080p copy fits in memory.
    const hd = videoPlan(probeOf({ duration: 600 }), '1080p');
    assert.equal(hd.place, 'memory');
    assert.ok(hd.bytes < 700 * MB);
  });

  test('memory up to the cap with a margin for an encoder’s overshoot', () => {
    assert.equal(MEMORY_MAX_BYTES, GB);
    assert.equal(outputPlace(MEMORY_MAX_BYTES / ESTIMATE_MARGIN), 'memory');
    assert.equal(outputPlace(MEMORY_MAX_BYTES / ESTIMATE_MARGIN + 1), null);
    assert.equal(outputPlace(MEMORY_MAX_BYTES / ESTIMATE_MARGIN + 1, { disk: true }), 'disk');
    assert.equal(outputPlace(null), 'memory', 'unknown: held, the cap enforced as it is made');
  });

  test('the original is read in pieces where the storage answers ranges, else whole up to a cap', () => {
    assert.equal(sourceRead({ range: true, bytes: 40 * GB }), 'range');
    assert.equal(sourceRead({ range: false, bytes: 200 * MB }), 'whole');
    assert.equal(sourceRead({ range: false, bytes: WHOLE_READ_MAX_BYTES + 1 }), null);
    assert.equal(sourceRead({ range: false, bytes: null }), null, 'unknown size, no ranges: not read');
  });

  test('time: longer for longer, larger and faster clips; a 4K copy of a 4K clip the longest', () => {
    const src = { width: 3840, height: 2160 };
    const t = (target, fps = 30, duration = 600) => estimateSeconds({ duration, fps, source: src, target });
    assert.ok(t({ width: 3840, height: 2160 }) > t({ width: 1920, height: 1080 }));
    assert.ok(t({ width: 1920, height: 1080 }) > t({ width: 1280, height: 720 }));
    assert.ok(t({ width: 1280, height: 720 }, 60) > t({ width: 1280, height: 720 }, 30));
    assert.ok(t({ width: 1280, height: 720 }, 30, 1200) > t({ width: 1280, height: 720 }, 30, 600));
    assert.equal(estimateSeconds({ duration: 0, source: src, target: src }), null);
    assert.equal(fmtMinutes(30), 'under a minute');
    assert.equal(fmtMinutes(95), '2 min');
    assert.equal(fmtMinutes(4000), '1 hr 7 min');
  });

  test('time: calibrated — no less than Safari took on an M5 Max, nor twice it; Chrome there faster still', () => {
    // Seconds each copy took in the browser harness (the original read from
    // an S3 API over ranges, in a worker): [source, target, fps, duration, Safari, Chrome].
    const k4 = { width: 3840, height: 2160 };
    const hd = { width: 1920, height: 1080 };
    const sd = { width: 1280, height: 720 };
    const measured = [
      [k4, k4, 30, 20, 15.6, 4.7],
      [k4, hd, 30, 20, 8.7, 1.7],
      [k4, hd, 60, 10, 8.5, 1.7],
      [hd, sd, 60, 30, 12.0, 4.2],
    ];
    for (const [source, target, fps, duration, safari, chrome] of measured) {
      const est = estimateSeconds({ duration, fps, source, target });
      assert.ok(est >= safari && est <= 2 * safari, `${target.height}p of ${source.height}p${fps}: ${est} s against Safari's ${safari}`);
      assert.ok(est > chrome);
    }
  });

  test('the time left follows the pace of the last fifteen seconds', () => {
    assert.equal(etaSeconds([]), null);
    assert.equal(etaSeconds([{ at: 0, fraction: 0 }, { at: 1000, fraction: 0.1 }]), null, 'too soon to tell');
    assert.equal(etaSeconds([{ at: 0, fraction: 0 }, { at: 10000, fraction: 0.25 }]), 30);
    // A slow start (the original's first megabytes) is forgotten once it is out of the window.
    const samples = [{ at: 0, fraction: 0 }, { at: 20000, fraction: 0.05 }, { at: 30000, fraction: 0.3 }];
    assert.equal(etaSeconds(samples), 28);
    assert.equal(etaSeconds([{ at: 0, fraction: 0.5 }, { at: 5000, fraction: 0.5 }]), null, 'no progress, no guess');
  });
});

describe('what this browser’s answers rule out', () => {
  test('a source it cannot decode (ProRes in Chrome): no copies', () => {
    assert.equal(videoPlan(probeOf({ codec: 'prores', decode: false }), '1080p').reason, 'decode');
  });

  test('a size its encoder refuses: that copy, not the others', () => {
    const probe = probeOf({}, { encode: { '2160p': false } });
    assert.equal(videoPlan(probe, '2160p').reason, 'encode');
    assert.equal(videoPlan(probe, '1080p').reason, undefined);
    // A probe that checked a different codec string than the plan would use is not trusted.
    assert.equal(videoPlan(probeOf({}, { encode: { '1080p': 'avc1.64002A' } }), '1080p').reason, 'encode');
  });

  test('sound it cannot make AAC of: no copies (Firefox has no AAC encoder)', () => {
    const opus = { codec: 'opus', channels: 2, sampleRate: 48000, decode: true };
    assert.equal(videoPlan(probeOf({}, { audio: opus, aac: false }), '1080p').reason, 'audio');
    assert.equal(videoPlan(probeOf({}, { audio: opus, aac: true }), '1080p').audio.mode, 'encode');
    // Its AAC copied: no encoder needed.
    assert.equal(videoPlan(probeOf({}, { aac: false }), '1080p').audio.mode, 'copy');
    assert.equal(videoPlan(probeOf({}, { audio: null }), '720p').audio.mode, 'none');
  });

  test('upscaling is never planned', () => {
    assert.equal(videoPlan(probeOf({ width: 1920, height: 1080 }), '2160p').reason, 'upscale');
  });

  test('a plan has everything the converter needs', () => {
    const plan = videoPlan(probeOf({ codec: 'hevc', hdr: true, transfer: 'hlg', hdrPath: 'canvas', fps: 29.97, frameRate: 29.97, duration: 12, bitrate: 20e6 }), '1080p');
    assert.equal(plan.codec, 'avc1.640028');
    assert.deepEqual([plan.width, plan.height], [1920, 1080]);
    assert.equal(plan.bitrate, 8e6);
    assert.equal(plan.keyFrameSeconds, KEYFRAME_SECONDS);
    assert.equal(plan.frameRate, 29.97, 'its frame lattice, kept');
    assert.deepEqual(plan.hdr, { transfer: 'hlg', via: 'canvas' }, 'HDR is taken to SDR on the way');
    assert.equal(plan.latencyMode, 'quality');
    assert.equal(plan.place, 'memory');
    assert.equal(plan.duration, 12);
    assert.ok(plan.seconds > 0);
    assert.equal(videoPlan(probeOf({ frameRate: null }), '1080p').frameRate, null, 'a variable rate: times kept as they are');
    assert.equal(videoPlan(probeOf(), '1080p').hdr, null, 'SDR: nothing to take anywhere');
    assert.equal(videoPlan(null, '1080p').reason, 'probe');
  });

  test('HDR only where this browser can take it to SDR faithfully: by its canvas, or from the frames’ planes', () => {
    const hdr = (hdrPath) => probeOf({ codec: 'hevc', hdr: true, transfer: 'pq', hdrPath });
    assert.deepEqual(videoPlan(hdr('shader'), '1080p').hdr, { transfer: 'pq', via: 'shader' }, 'WebKit: the planes, on the GPU');
    assert.equal(videoPlan(hdr(null), '1080p').reason, 'hdr', 'neither: not offered, rather than washed out');
    assert.match(videoReasonText('hdr', clip()), /HDR/);
  });

  test('the encoder’s profile and mode are the first it was seen to make every frame in — WebKit’s is Constrained Baseline', () => {
    assert.deepEqual(H264_MODES.map((m) => `${m.profile}/${m.latencyMode}`), ['high/quality', 'baseline/quality', 'high/realtime']);
    const chrome = videoPlan(probeOf(), '1080p');
    assert.deepEqual([chrome.codec, chrome.profile, chrome.latencyMode], ['avc1.640028', 'high', 'quality']);
    const webkit = videoPlan(probeOf({}, { h264: { profile: 'baseline', latencyMode: 'quality' } }), '1080p');
    assert.deepEqual([webkit.codec, webkit.profile, webkit.latencyMode], ['avc1.42E028', 'baseline', 'quality']);
    assert.equal(videoPlan(probeOf({}, { h264: { profile: 'high', latencyMode: 'realtime' } }), '720p').latencyMode, 'realtime');
    // A probe that found no mode that makes every frame marks every size unencodable.
    assert.equal(videoPlan(probeOf({}, { h264: null }), '720p').reason, 'encode');
  });

  test('Constrained Baseline: its own codec string, and its lower bitrate ceiling per level', () => {
    assert.equal(h264CodecString(31, 'baseline'), 'avc1.42E01F');
    assert.equal(h264CodecString(51, 'baseline'), 'avc1.42E033');
    // 720p30 at 11 Mb/s peaks at 16.5: inside 3.1 for High (14 × 1.25 = 17.5), past it for Baseline (14).
    assert.equal(h264Level({ width: 1280, height: 720, fps: 30, bitrate: 11e6, profile: 'high' }), 31);
    assert.equal(h264Level({ width: 1280, height: 720, fps: 30, bitrate: 11e6, profile: 'baseline' }), 32);
    assert.equal(videoEncoderConfig({ width: 3840, height: 2160, fps: 30 }, '2160p', { profile: 'baseline' }).codec, 'avc1.42E033');
  });
});

describe('the dialog’s rows', () => {
  test('while the original is looked at: the sizes on record, checking', () => {
    const c = videoChoices(clip(), { probe: null, convert: true });
    assert.deepEqual(c.rows.map((r) => [r.id, r.state, r.via]), [['2160p', 'checking', 'convert'], ['1080p', 'checking', 'convert'], ['720p', 'checking', 'convert']]);
    assert.equal(videoRowDetail(c.rows[0]), '3840 × 2160 · Checking…');
    assert.equal(c.reason, null);
  });

  test('then ready, with how big and how long — or too large, shown but not pickable', () => {
    const c = videoChoices(clip(), { probe: probeOf({ duration: 600 }), convert: true, disk: false });
    assert.deepEqual(c.rows.map((r) => [r.id, r.state, r.reason]), [['2160p', 'off', 'size'], ['1080p', 'ready', null], ['720p', 'ready', null]]);
    assert.match(videoRowDetail(c.rows[0]), /^3840 × 2160 · about 2\.\d GB — too large for this browser$/);
    assert.match(videoRowDetail(c.rows[1]), /^1920 × 1080 · about \d+ MB · \d+ min$/);
    assert.ok(c.rows[1].plan && c.rows[1].plan.codec === 'avc1.640028');
    // With a disk to write to, 4K is ready too.
    assert.equal(videoChoices(clip(), { probe: probeOf({ duration: 600 }), convert: true, disk: true }).rows[0].state, 'ready');
  });

  test('the proxy is the copy at its size — instant, whatever this browser can make', () => {
    const proxy = { available: true, size: 312 * MB };
    const c = videoChoices(clip(), { probe: probeOf(), proxy, convert: true });
    assert.deepEqual(c.rows.map((r) => [r.id, r.via]), [['2160p', 'convert'], ['1080p', 'proxy'], ['720p', 'convert']]);
    assert.equal(videoRowDetail(c.rows[1]), '1920 × 1080 · 312 MB');
    assert.equal(c.proxyUsed, true);
    const cannot = videoChoices(clip({ name: 'Master.mov' }), { probe: probeOf({ codec: 'prores', decode: false }), proxy, convert: true });
    assert.deepEqual(cannot.rows.map((r) => [r.id, r.via]), [['1080p', 'proxy']], 'ProRes: the original, the proxy, the still');
    assert.equal(cannot.reason, 'decode');
    assert.match(videoReasonText(cannot.reason, clip({ name: 'Master.mov' }), 'prores'), /can’t decode ProRes video/);
    assert.match(videoReasonText(cannot.reason, clip({ name: 'Master.mov' })), /can’t decode MOV video/, 'a codec it has no name for: the file’s type');
  });

  test('rows this browser cannot make at all are left out, and why is said', () => {
    assert.deepEqual(videoChoices(clip(), { convert: false }).rows, []);
    assert.equal(videoChoices(clip(), { convert: false }).reason, 'webcodecs');
    const failed = videoChoices(clip(), { probe: { ok: false, reason: 'read' }, convert: true });
    assert.deepEqual(failed.rows, []);
    assert.equal(failed.reason, 'read');
    assert.equal(videoChoices(clip({ url: null }), { convert: true }).reason, 'source');
    for (const r of ['webcodecs', 'decode', 'encode', 'audio', 'level', 'read', 'range', 'format', 'source', 'other']) {
      assert.ok(videoReasonText(r, clip()).length > 20, r);
    }
  });

  test('the probe’s size wins over the one on record', () => {
    const c = videoChoices(clip({ metadata: {} }), { probe: probeOf({ width: 1080, height: 1920 }), convert: true });
    assert.deepEqual(c.rows.map((r) => [r.id, r.width, r.height]), [['1080p', 1080, 1920], ['720p', 720, 1280]]);
  });

  test('downloadChoices and the menu: a video with copies to make is offered Download as…', () => {
    const env = { video: { convert: true } };
    assert.equal(offersDownloadAs(clip(), env), true);
    assert.equal(offersDownloadAs(clip(), {}), false, 'no WebCodecs, no proxy, no still: the original alone');
    assert.equal(offersDownloadAs(clip({ metadata: { width: 640, height: 360 } }), env), false, 'too small for any copy');
    const c = downloadChoices(clip(), { ...env, video: { convert: true, probe: probeOf({ codec: 'prores', decode: false }) } });
    assert.deepEqual(c.sizes, []);
    assert.equal(c.videoReason, 'decode');
    assert.equal(c.reason, 'nothing');
  });

  test('the proxy’s short edge, as the Mac makes it', () => {
    assert.equal(proxyShortEdge(clip()), 1080);
    assert.equal(proxyShortEdge(clip({ metadata: { width: 720, height: 1280 } })), 720);
    assert.equal(proxyShortEdge(clip({ metadata: {} })), 1080);
  });
});

describe('what a copy is called', () => {
  test('"Clip (1080p).mp4", "Clip (4K).mp4" — as the proxy at its size is', () => {
    assert.equal(videoDownloadName('Clip.mov', '1080p'), 'Clip (1080p).mp4');
    assert.equal(videoDownloadName('Clip.mov', '720p'), 'Clip (720p).mp4');
    assert.equal(videoDownloadName('Clip.mov', '2160p'), 'Clip (4K).mp4');
    assert.equal(videoDownloadName('Take 2.final.MOV', '1080p'), 'Take 2.final (1080p).mp4');
    assert.equal(videoDownloadName('IMG_0001.MOV', '1080p'), proxyDownloadName('IMG_0001.MOV', { height: 1080 }));
    assert.equal(videoDownloadName('a/b:c.webm', '720p'), 'a-b-c (720p).mp4');
    assert.equal(videoDownloadName('', '720p'), 'Download (720p).mp4');
    assert.deepEqual(VIDEO_TARGETS.map((t) => videoTarget(t.id).name), ['4K', '1080p', '720p']);
  });
});

describe('where a copy is written', () => {
  const write = async (sink, chunks) => {
    const w = sink.writable.getWriter();
    for (const c of chunks) await w.write(c);
    await w.close();
  };
  const bytes = (...v) => new Uint8Array(v);

  test('in memory: pieces kept as they come, and the one write back to the start lands in them', async () => {
    const sink = memorySink(1024);
    await write(sink, [
      { type: 'write', data: bytes(0, 0, 0, 0, 1, 2), position: 0 },
      { type: 'write', data: bytes(3, 4, 5), position: 6 },
      { type: 'write', data: bytes(9, 9), position: 2 },      // the media box's size, sealed at the end
      { type: 'write', data: bytes(7, 8), position: 11 },     // a gap is zeros
    ]);
    assert.equal(sink.size, 13);
    assert.deepEqual([...new Uint8Array(await sink.blob().arrayBuffer())], [0, 0, 9, 9, 1, 2, 3, 4, 5, 0, 0, 7, 8]);
    assert.equal(sink.blob().type, 'video/mp4');
  });

  test('an overwrite across two pieces', async () => {
    const sink = memorySink(1024);
    await write(sink, [
      { type: 'write', data: bytes(1, 1, 1), position: 0 },
      { type: 'write', data: bytes(2, 2, 2), position: 3 },
      { type: 'write', data: bytes(7, 7, 7, 7), position: 1 },
    ]);
    assert.deepEqual([...new Uint8Array(await sink.blob().arrayBuffer())], [1, 7, 7, 7, 7, 2]);
  });

  test('in memory, refused past its cap — the copy stops rather than taking the tab down', async () => {
    const sink = memorySink(8);
    const w = sink.writable.getWriter();
    await w.write({ type: 'write', data: new Uint8Array(8), position: 0 });
    await assert.rejects(w.write({ type: 'write', data: new Uint8Array(1), position: 8 }), (e) => e.code === 'size');
  });

  test('to disk: written as it comes, committed only when sealed; thrown away, never committed, when stopped', async () => {
    const log = [];
    const file = new WritableStream({
      write: (c) => { log.push(['write', c.position, c.data.length]); },
      close: () => { log.push(['close']); },
      abort: () => { log.push(['abort']); },
    });
    const done = fileSink(file);
    await write(done, [{ type: 'write', data: bytes(1, 2, 3), position: 0 }]);
    assert.deepEqual(log, [['write', 0, 3]], 'the muxer’s close does not commit the file');
    await done.seal();
    assert.deepEqual(log, [['write', 0, 3], ['close']]);
    assert.equal(done.size, 3);

    log.length = 0;
    const stopped = fileSink(new WritableStream({
      write: (c) => { log.push(['write', c.position, c.data.length]); },
      close: () => { log.push(['close']); },
      abort: () => { log.push(['abort']); },
    }));
    const w = stopped.writable.getWriter();
    await w.write({ type: 'write', data: bytes(1), position: 0 });
    await stopped.discard();
    await w.close().catch(() => {});
    assert.deepEqual(log, [['write', 0, 1], ['abort']], 'aborted, and the close that follows commits nothing');
  });
});
