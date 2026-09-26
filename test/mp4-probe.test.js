// The container probe behind the frame model. The fixtures are real files,
// made with the ffmpeg-static binary in node_modules and a few KB each:
//
//   h264-23976-tail.mp4  H.264, 24000/1001, 12 frames, moov AFTER mdat (the
//                        default without +faststart — most camera and NLE
//                        exports look like this)
//   prores-2997df-tc.mov ProRes Proxy, 30000/1001, 6 frames, with a QuickTime
//                        timecode track starting 01:00:00;00 drop-frame
//   h264-25-head.mp4     H.264, 25fps, 10 frames, moov first (+faststart)
//
//   ffmpeg -f lavfi -i "color=c=gray:s=64x36:r=24000/1001" -frames:v 12 \
//     -c:v libx264 -preset ultrafast -pix_fmt yuv420p -bf 0 h264-23976-tail.mp4
//   ffmpeg -f lavfi -i "color=c=gray:s=64x36:r=30000/1001" -frames:v 6 \
//     -c:v prores_ks -profile:v 0 -timecode "01:00:00;00" prores-2997df-tc.mov
//   ffmpeg -f lavfi -i "color=c=gray:s=64x36:r=25" -frames:v 10 -c:v libx264 \
//     -preset ultrafast -pix_fmt yuv420p -movflags +faststart h264-25-head.mp4
//
// The shapes a fixture cannot cheaply carry — a 64-bit box size, a moov past
// 4 GB, co64, 59.94 — are built from boxes in memory below.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { probeMp4, probeMetadata, rangeReader } from '../lib/mp4-probe.js';
import { timecode, parseTimecode } from '../lib/video-time.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** A readRange over bytes in memory that records what it was asked for. */
function reader(bytes) {
  const calls = [];
  const readRange = async (start, end) => {
    calls.push([start, end]);
    return bytes.subarray(start, end);
  };
  return { readRange, calls, size: bytes.byteLength };
}

describe('real files', () => {
  test('H.264 at 23.976 with the moov at the tail', async () => {
    const f = reader(fixture('h264-23976-tail.mp4'));
    const p = await probeMp4(f.readRange, { size: f.size });
    assert.deepEqual(p.fps, { num: 24000, den: 1001 });
    assert.equal(p.frames, 12);
    assert.equal(p.width, 64);
    assert.equal(p.height, 36);
    assert.equal(p.codec, 'avc1');
    assert.equal(p.tcStart, 0);
    assert.equal(p.dropFrame, false);
    assert.ok(Math.abs(p.duration - 12 * 1001 / 24000) < 1e-9);
    // The media data is never read: header walks, then the moov.
    const moovRead = f.calls.find(([s, e]) => e - s > 16);
    assert.ok(moovRead, 'the moov was read');
    assert.equal(moovRead[1], f.size, 'and it is the last box');
  });

  test('ProRes at 29.97 with a drop-frame timecode track', async () => {
    const f = reader(fixture('prores-2997df-tc.mov'));
    const p = await probeMp4(f.readRange, { size: f.size });
    assert.deepEqual(p.fps, { num: 30000, den: 1001 });
    assert.equal(p.frames, 6);
    assert.match(p.codec, /^apc[onhs4]$|^ap4[hx]$/);
    assert.equal(p.width, 64);
    assert.equal(p.dropFrame, true);
    // 01:00:00;00 is frame 107892 of 29.97 drop-frame, not 108000.
    assert.equal(p.tcStart, 107892);
    assert.equal(timecode(0, { fps: p.fps, tcStart: p.tcStart, dropFrame: p.dropFrame }), '01:00:00;00');
    assert.equal(timecode(5, { fps: p.fps, tcStart: p.tcStart, dropFrame: p.dropFrame }), '01:00:00;05');
    assert.equal(parseTimecode('01:00:00;05', { fps: p.fps, tcStart: p.tcStart }), 5);
  });

  test('H.264 at 25 with the moov first', async () => {
    const f = reader(fixture('h264-25-head.mp4'));
    const p = await probeMp4(f.readRange, { size: f.size });
    assert.deepEqual(p.fps, { num: 25, den: 1 });
    assert.equal(p.frames, 10);
    assert.equal(p.tcStart, 0);
    // moov right after ftyp: two header reads and the moov itself.
    assert.ok(f.calls.length <= 3, `${f.calls.length} reads`);
  });

  test('metadata carries the frame model and nothing a probe does not own', async () => {
    const f = reader(fixture('prores-2997df-tc.mov'));
    const meta = probeMetadata(await probeMp4(f.readRange, { size: f.size }));
    assert.deepEqual(meta, { fps: { num: 30000, den: 1001 }, tcStart: 107892, dropFrame: true, frames: 6 });
    assert.deepEqual(probeMetadata(null), {});
    assert.deepEqual(probeMetadata({ fps: null, frames: 9 }), {}, 'a count without a rate means nothing');
  });
});

// ── Boxes in memory ──────────────────────────────────────────────────────────

const enc = new TextEncoder();
function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; }
function u16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n); return b; }
function u64(n) { const b = new Uint8Array(8); const v = new DataView(b.buffer); v.setUint32(0, Math.floor(n / 2 ** 32)); v.setUint32(4, n % 2 ** 32); return b; }
function cat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}
const zeros = (n) => new Uint8Array(n);
const box = (type, ...body) => { const b = cat(...body); return cat(u32(b.byteLength + 8), enc.encode(type), b); };
const full = (type, ...body) => box(type, zeros(4), ...body);

const mdhd = (timescale, duration) => full('mdhd', zeros(8), u32(timescale), u32(duration), zeros(4));
const hdlr = (kind) => full('hdlr', zeros(4), enc.encode(kind), zeros(12));
const stts = (...entries) => full('stts', u32(entries.length), ...entries.flatMap(([n, d]) => [u32(n), u32(d)]));
const visual = (codec, w, h) => box(codec, zeros(8), zeros(16), u16(w), u16(h), zeros(50));
const stsd = (entry) => full('stsd', u32(1), entry);
const tmcdEntry = ({ drop, timescale, frameDuration, base }) =>
  box('tmcd', zeros(8), zeros(4), u32(drop ? 1 : 0), u32(timescale), u32(frameDuration), new Uint8Array([base, 0]));

function videoTrak({ timescale, delta, frames, codec = 'avc1', w = 1920, h = 1080, sttsEntries }) {
  return box('trak', box('mdia', mdhd(timescale, delta * frames), hdlr('vide'),
    box('minf', box('stbl', stsd(visual(codec, w, h)), stts(...(sttsEntries || [[frames, delta]]))))));
}
function tmcdTrak({ drop, timescale, frameDuration, base, offset, wide = false }) {
  const chunk = wide ? full('co64', u32(1), u64(offset)) : full('stco', u32(1), u32(offset));
  return box('trak', box('mdia', mdhd(timescale, frameDuration), hdlr('tmcd'),
    box('minf', box('stbl', stsd(tmcdEntry({ drop, timescale, frameDuration, base })), stts([1, frameDuration]), chunk))));
}

describe('built boxes', () => {
  test('59.94 drop-frame starting 01:00:00;00', async () => {
    const ftyp = box('ftyp', enc.encode('qt  '), zeros(4));
    const start = 215784; // 01:00:00;00 at 59.94 DF
    const mdat = box('mdat', u32(start));
    const sampleAt = ftyp.byteLength + 8;
    const moov = box('moov',
      videoTrak({ timescale: 60000, delta: 1001, frames: 600, codec: 'apch' }),
      tmcdTrak({ drop: true, timescale: 60000, frameDuration: 1001, base: 60, offset: sampleAt }));
    const f = reader(cat(ftyp, mdat, moov));
    const p = await probeMp4(f.readRange, { size: f.size });
    assert.deepEqual(p.fps, { num: 60000, den: 1001 });
    assert.equal(p.tcStart, start);
    assert.equal(p.dropFrame, true);
    assert.equal(timecode(0, { fps: p.fps, tcStart: p.tcStart, dropFrame: true }), '01:00:00;00');
  });

  test('a 64-bit mdat: the moov past 4 GB is reached in a handful of small reads', async () => {
    // Sparse: the "file" is 6 GB of which only the header and tail exist.
    const ftyp = box('ftyp', enc.encode('isom'), zeros(4));
    const big = 6 * 2 ** 30;
    const mdatHead = cat(u32(1), enc.encode('mdat'), u64(big));
    const moov = box('moov', videoTrak({ timescale: 90000, delta: 3754, frames: 1000 }),
      tmcdTrak({ drop: false, timescale: 24000, frameDuration: 1001, base: 24, offset: ftyp.byteLength + 16, wide: true }));
    const moovAt = ftyp.byteLength + big;
    const size = moovAt + moov.byteLength;
    const calls = [];
    const readRange = async (s, e) => {
      calls.push([s, e]);
      const out = new Uint8Array(e - s);
      const head = cat(ftyp, mdatHead, u32(86400)); // the tmcd sample sits at the start of mdat's data
      for (let i = s; i < e; i++) {
        if (i < head.byteLength) out[i - s] = head[i];
        else if (i >= moovAt) out[i - s] = moov[i - moovAt];
      }
      return out;
    };
    const p = await probeMp4(readRange, { size });
    // 90000/3754 is how a 90 kHz muxer writes 23.976; it snaps to the real rate.
    assert.deepEqual(p.fps, { num: 24000, den: 1001 });
    assert.equal(p.frames, 1000);
    assert.equal(p.tcStart, 86400, 'from co64');
    assert.equal(p.dropFrame, false);
    assert.ok(calls.length <= 5, `${calls.length} reads`);
    const bytes = calls.reduce((n, [s, e]) => n + (e - s), 0);
    assert.ok(bytes < moov.byteLength + 100, `read ${bytes} bytes of a 6 GB file`);
  });

  test('the dominant sample delta sets the rate, not an odd first one', async () => {
    const moov = box('moov', videoTrak({ timescale: 25, delta: 1, frames: 0, sttsEntries: [[1, 2], [249, 1]] }));
    const f = reader(cat(box('ftyp', enc.encode('isom')), moov));
    const p = await probeMp4(f.readRange, { size: f.size });
    assert.deepEqual(p.fps, { num: 25, den: 1 });
    assert.equal(p.frames, 250);
  });

  test('no timecode track is a zero start, not a failure', async () => {
    const f = reader(cat(box('ftyp', enc.encode('isom')), box('moov', videoTrak({ timescale: 30, delta: 1, frames: 30 }))));
    const p = await probeMp4(f.readRange, { size: f.size });
    assert.deepEqual(p.fps, { num: 30, den: 1 });
    assert.equal(p.tcStart, 0);
    assert.equal(p.dropFrame, false);
  });

  test('what is not a video it can read is null, not a throw', async () => {
    const cases = {
      'not a container': new Uint8Array(64).fill(0xff),
      'no moov': cat(box('ftyp', enc.encode('isom')), box('mdat', zeros(32))),
      'audio only': cat(box('ftyp', enc.encode('isom')), box('moov', box('trak', box('mdia', mdhd(48000, 48000), hdlr('soun'))))),
      'truncated moov': cat(box('ftyp', enc.encode('isom')), box('moov', videoTrak({ timescale: 30, delta: 1, frames: 30 })).subarray(0, 40)),
      'box larger than the file': cat(u32(9999), enc.encode('ftyp'), zeros(8)),
      tiny: zeros(8),
    };
    for (const [name, bytes] of Object.entries(cases)) {
      const f = reader(bytes);
      assert.equal(await probeMp4(f.readRange, { size: f.size }), null, name);
    }
    assert.equal(await probeMp4(null, { size: 100 }), null);
    assert.equal(await probeMp4(async () => new Uint8Array(0), {}), null, 'no size');
  });

  test('an empty sample table leaves the rate unknown', async () => {
    const moov = box('moov', videoTrak({ timescale: 30, delta: 1, frames: 0, sttsEntries: [] }));
    const f = reader(cat(box('ftyp', enc.encode('isom')), moov));
    const p = await probeMp4(f.readRange, { size: f.size });
    assert.equal(p.fps, null);
    assert.deepEqual(probeMetadata(p), {});
  });
});

describe('rangeReader', () => {
  const bytes = fixture('h264-23976-tail.mp4');
  const server = (status = 206) => async (_url, { headers }) => {
    const [, s, e] = /bytes=(\d+)-(\d+)/.exec(headers.range);
    const body = bytes.subarray(Number(s), Number(e) + 1);
    return {
      status,
      headers: new Map([['content-range', `bytes ${s}-${e}/${bytes.byteLength}`]]),
      arrayBuffer: async () => (status === 206 ? body : bytes).slice().buffer,
      body: { cancel: async () => {} },
    };
  };

  test('probes a stored object through range requests', async () => {
    const { readRange, size } = await rangeReader('https://bucket.test/x', { fetchImpl: server() });
    assert.equal(size, bytes.byteLength);
    const p = await probeMp4(readRange, { size });
    assert.deepEqual(p.fps, { num: 24000, den: 1001 });
  });

  test('refuses a server that ignores Range rather than download a master', async () => {
    await assert.rejects(rangeReader('https://bucket.test/x', { fetchImpl: server(200) }), /range request refused/);
  });

  test('a probe cannot pull more than its budget', async () => {
    const { readRange, size } = await rangeReader('https://bucket.test/x', { fetchImpl: server(), budget: 200 });
    await assert.rejects(probeMp4(readRange, { size }), /budget/);
  });
});
