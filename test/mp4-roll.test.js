// A copy's AAC tracks are marked as each sample needing the one before it
// (lib/mp4-roll.js), so Apple's players skip exactly the priming its edit
// list says — and the sinks the copy is written into (lib/video-convert.js)
// make that change to the moov as they seal the file.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { boxesIn, moovOffset, withAacRollGroups } from '../lib/mp4-roll.js';
import { memorySink, fileSink } from '../lib/video-convert.js';

const enc = (s) => [...s].map((c) => c.charCodeAt(0));
const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
/** A box: 32-bit size, type, then its bytes and children. */
const box = (type, ...content) => {
  const body = content.flat(Infinity);
  return [...u32(8 + body.length), ...enc(type), ...body];
};
const full = (type, version, ...content) => box(type, [version, 0, 0, 0], ...content);

/** A track: `handler` 'soun' or 'vide', an mp4a/avc1 entry, `samples` samples, and an edit list starting at `mediaTime` (null: none). */
function trak({ handler = 'soun', samples = 10, mediaTime = 1024, roll = false } = {}) {
  const entry = handler === 'soun' ? box('mp4a', new Array(28).fill(0)) : box('avc1', new Array(78).fill(0));
  const stbl = box('stbl',
    full('stsd', 0, u32(1), entry),
    full('stts', 0, u32(1), u32(samples), u32(1024)),
    full('stsz', 0, u32(0), u32(samples), new Array(samples).fill(u32(100))),
    full('stco', 0, u32(1), u32(40)),
    roll ? full('sgpd', 1, enc('roll'), u32(2), u32(1), [0xff, 0xff]) : []);
  return box('trak',
    full('tkhd', 0, new Array(80).fill(0)),
    mediaTime == null ? [] : box('edts', full('elst', 0, u32(1), u32(3000), u32(mediaTime), [0, 1, 0, 0])),
    box('mdia',
      full('mdhd', 0, new Array(20).fill(0)),
      full('hdlr', 0, u32(0), enc(handler), new Array(12).fill(0), [0]),
      box('minf', box('dinf', []), stbl)));
}
const moov = (...traks) => Uint8Array.from(box('moov', full('mvhd', 0, new Array(96).fill(0)), ...traks));

/** The boxes along a path of types, from the top of `bytes`. */
function find(bytes, path, from = 0, to = bytes.length) {
  const [head, ...rest] = path;
  for (const b of boxesIn(bytes, from, to)) {
    if (b.type !== head) continue;
    if (!rest.length) return b;
    const deeper = b.type === 'stsd' ? null : find(bytes, rest, b.body, b.at + b.size);
    if (deeper) return deeper;
  }
  return null;
}
const all = (bytes, type, from = 0, to = bytes.length, out = []) => {
  for (const b of boxesIn(bytes, from, to)) {
    if (b.type === type) out.push(b);
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts'].includes(b.type)) all(bytes, type, b.body, b.at + b.size, out);
  }
  return out;
};

describe('roll groups for AAC', () => {
  test('added to a sound track whose edit list skips priming — and every box around them grows by exactly as much', () => {
    const before = moov(trak({ handler: 'vide', mediaTime: 0 }), trak({ handler: 'soun', samples: 143, mediaTime: 2112 }));
    const after = withAacRollGroups(before);
    assert.equal(after.length, before.length + 54);
    // Still a well-formed tree, every size adding up.
    const top = boxesIn(after, 0, after.length);
    assert.equal(top.length, 1);
    assert.equal(top[0].size, after.length);
    const sgpd = all(after, 'sgpd');
    const sbgp = all(after, 'sbgp');
    assert.equal(sgpd.length, 1);
    assert.equal(sbgp.length, 1);
    // sgpd: version 1, 'roll', default length 2, one entry, distance -1.
    assert.deepEqual([...after.subarray(sgpd[0].body, sgpd[0].at + sgpd[0].size)], [1, 0, 0, 0, ...enc('roll'), 0, 0, 0, 2, 0, 0, 0, 1, 0xff, 0xff]);
    // sbgp: every one of the 143 samples in group 1.
    assert.deepEqual([...after.subarray(sbgp[0].body, sbgp[0].at + sbgp[0].size)], [0, 0, 0, 0, ...enc('roll'), 0, 0, 0, 1, ...u32(143), 0, 0, 0, 1]);
    // In the sound track's stbl, after what was there.
    const traks = all(after, 'trak');
    assert.equal(all(after, 'sgpd', traks[0].body, traks[0].at + traks[0].size).length, 0, 'not the video track');
    const stbl = all(after, 'stbl', traks[1].body, traks[1].at + traks[1].size)[0];
    assert.deepEqual(boxesIn(after, stbl.body, stbl.at + stbl.size).map((b) => b.type), ['stsd', 'stts', 'stsz', 'stco', 'sgpd', 'sbgp']);
  });

  test('left alone: no edit list (Apple’s players then skip their own default, as of the original), roll groups already there, video', () => {
    const none = moov(trak({ mediaTime: null }));
    assert.equal(withAacRollGroups(none), none);
    const already = moov(trak({ roll: true }));
    assert.equal(withAacRollGroups(already), already);
    const video = moov(trak({ handler: 'vide' }));
    assert.equal(withAacRollGroups(video), video);
    const empty = moov(trak({ mediaTime: 0 }));
    assert.equal(withAacRollGroups(empty), empty, 'an edit list that skips nothing');
    // Done once, done: the second time changes nothing.
    const once = withAacRollGroups(moov(trak()));
    assert.equal(withAacRollGroups(once), once);
    assert.equal(withAacRollGroups(Uint8Array.from([1, 2, 3])).length, 3, 'not a moov: as it was');
  });

  test('two sound tracks: both marked, the second’s boxes shifted by the first’s', () => {
    const after = withAacRollGroups(moov(trak({ samples: 5 }), trak({ samples: 7 })));
    assert.equal(all(after, 'sbgp').length, 2);
    const counts = all(after, 'sbgp').map((b) => after[b.body + 15]);
    assert.deepEqual(counts, [5, 7]);
    assert.equal(boxesIn(after, 0, after.length)[0].size, after.length);
  });

  test('the moov is found after the media, from the file’s first bytes — a 64-bit media box too', () => {
    const ftyp = box('ftyp', enc('isom'), u32(512), enc('isom'));
    assert.equal(moovOffset(Uint8Array.from([...ftyp, ...u32(1000), ...enc('mdat')])), ftyp.length + 1000);
    const large = [...u32(1), ...enc('mdat'), ...u32(1), ...u32(16)]; // 2^32 + 16 bytes
    assert.equal(moovOffset(Uint8Array.from([...ftyp, ...large])), ftyp.length + 2 ** 32 + 16);
    assert.equal(moovOffset(Uint8Array.from([...ftyp, ...box('moov', [])])), ftyp.length, 'a moov first');
    assert.equal(moovOffset(Uint8Array.from([...ftyp])), null);
  });
});

describe('sealing the file', () => {
  const ftyp = box('ftyp', enc('isom'), u32(512), enc('isom'));
  const mdat = [...u32(1), ...enc('mdat'), ...u32(0), ...u32(16 + 400)]; // a 64-bit header, as the muxer reserves
  const media = new Array(400).fill(7);
  const file = () => Uint8Array.from([...ftyp, ...mdat, ...media, ...moov(trak({ samples: 4 }))]);
  // As the muxer writes it: in pieces, the media box's size last, back at the start.
  const pieces = (bytes) => [
    { type: 'write', data: bytes.subarray(0, 100), position: 0 },
    { type: 'write', data: bytes.subarray(100, 300), position: 100 },
    { type: 'write', data: bytes.subarray(300), position: 300 },
  ];

  test('in memory: the moov gets its roll groups; the media is untouched', async () => {
    const bytes = file();
    const sink = memorySink(1 << 20);
    const w = sink.writable.getWriter();
    for (const p of pieces(bytes)) await w.write(p);
    await w.close();
    sink.finishing();
    await sink.seal();
    const out = new Uint8Array(await sink.blob().arrayBuffer());
    assert.equal(out.length, bytes.length + 54);
    assert.deepEqual([...out.subarray(0, ftyp.length + mdat.length + media.length)], [...bytes.subarray(0, ftyp.length + mdat.length + media.length)]);
    assert.equal(all(out, 'sgpd', ftyp.length + mdat.length + media.length).length, 1);
    assert.equal(sink.size, out.length);
  });

  test('to disk: what is written after finishing() is kept, and the moov written again, grown, before the file is committed', async () => {
    const bytes = file();
    const disk = new Uint8Array(bytes.length + 100);
    let end = 0;
    const log = [];
    const sink = fileSink(new WritableStream({
      write: (c) => { disk.set(c.data, c.position); end = Math.max(end, c.position + c.data.length); log.push(['write', c.position, c.data.length]); },
      close: () => { log.push(['close']); },
    }));
    const w = sink.writable.getWriter();
    const [a, b, c] = pieces(bytes);
    await w.write(a);
    sink.finishing();
    await w.write(b);
    await w.write(c);
    await w.close();
    await sink.seal();
    const moovAt = ftyp.length + mdat.length + media.length;
    assert.deepEqual(log.at(-2), ['write', moovAt, bytes.length - moovAt + 54]);
    assert.deepEqual(log.at(-1), ['close']);
    const out = disk.subarray(0, end);
    assert.equal(out.length, bytes.length + 54);
    assert.equal(all(out, 'sbgp', moovAt).length, 1);
    assert.equal(sink.size, out.length);
  });
});
