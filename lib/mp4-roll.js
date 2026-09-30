// lib/mp4-roll.js — marks an MP4's AAC tracks as each sample needing the one
// before it to decode ("roll" sample groups, ISO/IEC 14496-12 §10.1), as
// Apple's and FFmpeg's muxers do and mediabunny's does not.
//
// Why it matters: AAC starts with priming — silence of the encoder's own —
// that an edit list skips. Given an edit list and no roll groups, Apple's
// players (QuickTime, Safari, Onyx for Mac) skip the edit list's priming and
// then their own default of 2112 samples again, and the sound comes 44 ms
// before its picture; FFmpeg and Chrome skip only the edit list's. With roll
// groups, every player skips exactly what the edit list says. Measured: an
// otherwise identical copy plays 44 ms early in QuickTime without them, in
// sync with them, and in sync in FFmpeg either way.
//
// Pure: bytes in, bytes out. Only the `moov` changes, growing by 54 bytes a
// track; the copy's `moov` is written last (after the media), so no sample's
// offset moves.

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const put32 = (b, o, v) => { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; };
const type = (b, o) => String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);

/** The child boxes of [start, end): { type, at, size, body }. Stops at the first that does not fit. */
export function boxesIn(b, start, end) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o);
    let header = 8;
    if (size === 1) {
      if (o + 16 > end) break;
      size = u32(b, o + 8) * 2 ** 32 + u32(b, o + 12);
      header = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < header || o + size > end) break;
    out.push({ type: type(b, o), at: o, size, body: o + header });
    o += size;
  }
  return out;
}

const child = (b, box, name) => boxesIn(b, box.body, box.at + box.size).find((x) => x.type === name) || null;

/** The number of samples in a stbl: stsz's count (or stz2's). */
function sampleCount(b, stbl) {
  const stsz = child(b, stbl, 'stsz') || child(b, stbl, 'stz2');
  return stsz ? u32(b, stsz.body + 8) : 0;
}

const ROLL = [0x72, 0x6f, 0x6c, 0x6c]; // 'roll'

/** sgpd (version 1): one roll entry, distance -1. */
function sgpd() {
  return Uint8Array.from([0, 0, 0, 26, 0x73, 0x67, 0x70, 0x64, 1, 0, 0, 0, ...ROLL, 0, 0, 0, 2, 0, 0, 0, 1, 0xff, 0xff]);
}

/** sbgp: all `count` samples in group 1. */
function sbgp(count) {
  const out = Uint8Array.from([0, 0, 0, 28, 0x73, 0x62, 0x67, 0x70, 0, 0, 0, 0, ...ROLL, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1]);
  put32(out, 20, count);
  return out;
}

/**
 * Where the `moov` of a file laid out as the copy is — ftyp, the media, then
 * moov — starts, from its first bytes (`head`), or null: the box after the
 * last one whose header is in `head` (a 64-bit size included).
 */
export function moovOffset(head) {
  let o = 0;
  while (o + 8 <= head.length) {
    let size = u32(head, o);
    if (size === 1) {
      if (o + 16 > head.length) return null;
      size = u32(head, o + 8) * 2 ** 32 + u32(head, o + 12);
    }
    if (size < 8) return null;
    if (type(head, o) === 'moov') return o;
    if (type(head, o) === 'mdat') return o + size;
    o += size;
  }
  return null;
}

/** Whether a track's edit list starts its media after zero — priming it skips. */
function skipsPriming(b, trak) {
  const edts = child(b, trak, 'edts');
  const elst = edts && child(b, edts, 'elst');
  if (!elst || u32(b, elst.body + 4) < 1) return false;
  const version = b[elst.body];
  // Signed: -1 is an empty edit; past zero is media skipped.
  const mediaTime = version === 1
    ? (u32(b, elst.body + 16) | 0) * 2 ** 32 + u32(b, elst.body + 20)
    : u32(b, elst.body + 12) | 0;
  return mediaTime > 0;
}

/**
 * `moov` (the box's bytes) with roll groups added to each AAC track whose
 * edit list skips priming and that has none: a new Uint8Array, or the same
 * one when nothing needed them. A track with no edit list is left as it is:
 * Apple's players then skip their default 2112 samples, as they would of
 * the original.
 */
export function withAacRollGroups(moov) {
  const top = boxesIn(moov, 0, moov.length)[0];
  if (!top || top.type !== 'moov' || top.size !== moov.length) return moov;
  const inserts = []; // { at: offset in moov, bytes, parents: [offsets of size fields to grow] }
  for (const trak of boxesIn(moov, top.body, top.size).filter((x) => x.type === 'trak')) {
    const mdia = child(moov, trak, 'mdia');
    const minf = mdia && child(moov, mdia, 'minf');
    const stbl = minf && child(moov, minf, 'stbl');
    const hdlr = mdia && child(moov, mdia, 'hdlr');
    if (!stbl || !hdlr) continue;
    // Only boxes with 32-bit sizes are grown; a 64-bit one is left as it is.
    if ([top, trak, mdia, minf, stbl].some((x) => u32(moov, x.at) === 1)) continue;
    const handler = String.fromCharCode(...moov.subarray(hdlr.body + 8, hdlr.body + 12));
    if (handler !== 'soun') continue;
    const stsd = child(moov, stbl, 'stsd');
    const entry = stsd && boxesIn(moov, stsd.body + 8, stsd.at + stsd.size)[0];
    if (!entry || entry.type !== 'mp4a') continue;
    if (!skipsPriming(moov, trak)) continue;
    const kids = boxesIn(moov, stbl.body, stbl.at + stbl.size);
    if (kids.some((k) => (k.type === 'sgpd' || k.type === 'sbgp') && type(moov, k.at + 8) === 'roll')) continue;
    const count = sampleCount(moov, stbl);
    if (!count) continue;
    const bytes = new Uint8Array(54);
    bytes.set(sgpd(), 0);
    bytes.set(sbgp(count), 26);
    inserts.push({ at: stbl.at + stbl.size, bytes, parents: [top.at, trak.at, mdia.at, minf.at, stbl.at] });
  }
  if (!inserts.length) return moov;
  const grow = inserts.reduce((n, i) => n + i.bytes.length, 0);
  const out = new Uint8Array(moov.length + grow);
  let from = 0;
  let to = 0;
  for (const ins of inserts.sort((a, b) => a.at - b.at)) {
    out.set(moov.subarray(from, ins.at), to);
    to += ins.at - from;
    out.set(ins.bytes, to);
    to += ins.bytes.length;
    from = ins.at;
  }
  out.set(moov.subarray(from), to);
  // Each box that now holds more: its size, where it now sits.
  const shift = (offset) => offset + inserts.filter((i) => i.at <= offset).reduce((n, i) => n + i.bytes.length, 0);
  const grown = new Map();
  for (const ins of inserts) for (const p of ins.parents) grown.set(p, (grown.get(p) || 0) + ins.bytes.length);
  for (const [p, extra] of grown) {
    const at = shift(p);
    put32(out, at, u32(out, at) + extra);
  }
  return out;
}
