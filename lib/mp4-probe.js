// lib/mp4-probe.js — a video's frame rate, frame count and start timecode,
// read from its container.
//
// Browsers do not expose a video's frame rate. The player assumed 30fps, so at
// 23.976 its timecode was off by a frame within a second and a comment pinned
// to "frame 1439" reopened somewhere else. The container knows exactly; this
// reads it.
//
// ISO-BMFF (MP4, M4V) and QuickTime (MOV, ProRes included) share one box
// structure, and everything needed is in the `moov` box:
//
//   moov/trak (video)/mdia/mdhd   timescale, duration
//                     /minf/stbl/stts  sample deltas → frame rate and count
//                               /stsd  the sample entry → coded width, height
//   moov/trak (tmcd)/…/stsd       QuickTime timecode: drop-frame flag, rate
//                     /stco|co64  where its one sample is → the start frame
//
// Isomorphic, and imports only the rate arithmetic. It reads through an injected
// `readRange(start, end) → Uint8Array` (end exclusive, like File.slice), so the
// browser probes a local file at upload (File.slice) and the server probes a
// stored one with range GETs (rangeReader below), and neither ever reads the
// media data: the top-level walk costs one 16-byte read per box, so a `moov`
// at the tail of a 40 GB master is found in three or four small requests.

import { toRate } from './video-time.js';

// A moov bigger than this is not read. An hour of 24fps H.264 has a moov of
// well under 2 MB; 64 MB is a day of footage, and past it a misread size is
// likelier than a real file.
const MAX_MOOV_BYTES = 64 * 1024 * 1024;
// Top-level boxes walked before giving up. A real file has a handful.
const MAX_TOP_LEVEL_BOXES = 256;

const TMCD_DROP_FRAME = 0x0001;

class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length() { return this.b.byteLength; }

  has(offset, n) { return offset >= 0 && offset + n <= this.b.byteLength; }

  u8(o) { return this.v.getUint8(o); }

  u16(o) { return this.v.getUint16(o); }

  u32(o) { return this.v.getUint32(o); }

  i32(o) { return this.v.getInt32(o); }

  u64(o) {
    // Above 2^53 is not a real offset or duration; Number keeps the rest exact.
    return this.v.getUint32(o) * 2 ** 32 + this.v.getUint32(o + 4);
  }

  type(o) {
    return String.fromCharCode(this.b[o], this.b[o + 1], this.b[o + 2], this.b[o + 3]);
  }
}

/**
 * The child boxes of the box body [start, end) as { type, start, end, body }:
 * `body` is where the contents begin, after the 8- or 16-byte header. Stops at
 * the first malformed header rather than guessing past it.
 */
function children(r, start, end) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = r.u32(o);
    const type = r.type(o + 4);
    let header = 8;
    if (size === 1) {
      if (!r.has(o + 8, 8)) break;
      size = r.u64(o + 8);
      header = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < header || o + size > end) break;
    out.push({ type, start: o, end: o + size, body: o + header });
    o += size;
  }
  return out;
}

const child = (r, box, type) => children(r, box.body, box.end).find((c) => c.type === type) || null;

function path(r, box, ...types) {
  let cur = box;
  for (const t of types) {
    cur = cur && child(r, cur, t);
    if (!cur) return null;
  }
  return cur;
}

/** mdhd → { timescale, duration } (version 0 has 32-bit fields, version 1 64-bit). */
function readMdhd(r, box) {
  if (!box || !r.has(box.body, 4)) return null;
  const version = r.u8(box.body);
  const o = box.body + 4;
  if (version === 1) {
    if (!r.has(o, 28)) return null;
    return { timescale: r.u32(o + 16), duration: r.u64(o + 20) };
  }
  if (!r.has(o, 16)) return null;
  return { timescale: r.u32(o + 8), duration: r.u32(o + 12) };
}

/** stts → { samples, delta }: the total sample count and the delta most samples have. */
function readStts(r, box) {
  if (!box || !r.has(box.body, 8)) return null;
  const count = r.u32(box.body + 4);
  let samples = 0;
  let best = { count: 0, delta: 0 };
  for (let i = 0; i < count; i++) {
    const o = box.body + 8 + i * 8;
    if (!r.has(o, 8)) return null;
    const n = r.u32(o);
    const delta = r.u32(o + 4);
    samples += n;
    // The dominant delta rather than the first: some encoders give the first
    // sample (or the last) a different duration, and it would set the rate
    // of the whole clip.
    if (n > best.count) best = { count: n, delta };
  }
  return { samples, delta: best.delta };
}

/** The first entry of stsd, as a box. */
function firstSampleEntry(r, stbl) {
  const stsd = child(r, stbl, 'stsd');
  if (!stsd || !r.has(stsd.body, 8) || r.u32(stsd.body + 4) < 1) return null;
  return children(r, stsd.body + 8, stsd.end)[0] || null;
}

/** Offset of a track's first chunk, from stco or co64. */
function firstChunkOffset(r, stbl) {
  const stco = child(r, stbl, 'stco');
  if (stco && r.has(stco.body, 12) && r.u32(stco.body + 4) > 0) return r.u32(stco.body + 8);
  const co64 = child(r, stbl, 'co64');
  if (co64 && r.has(co64.body, 16) && r.u32(co64.body + 4) > 0) return r.u64(co64.body + 8);
  return null;
}

function handlerOf(r, trak) {
  const hdlr = path(r, trak, 'mdia', 'hdlr');
  // FullBox (4) + pre_defined / component type (4), then the handler type.
  return hdlr && r.has(hdlr.body, 12) ? r.type(hdlr.body + 8) : null;
}

/**
 * A timescale and a sample delta as a frame rate: reduced, and snapped to the
 * standard rate it stands for (a 90 kHz 90000/3754 is 24000/1001), or null.
 */
function rational(num, den) {
  if (!Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0) return null;
  return toRate({ num, den });
}

function readVideoTrack(r, trak) {
  const mdia = child(r, trak, 'mdia');
  const stbl = mdia && path(r, mdia, 'minf', 'stbl');
  const mdhd = readMdhd(r, mdia && child(r, mdia, 'mdhd'));
  if (!stbl || !mdhd?.timescale) return null;
  const stts = readStts(r, child(r, stbl, 'stts'));
  const entry = firstSampleEntry(r, stbl);
  // VisualSampleEntry: 8 bytes of SampleEntry, 16 of pre-defined/reserved,
  // then width and height as 16-bit integers — the coded size.
  const width = entry && r.has(entry.body + 24, 4) ? r.u16(entry.body + 24) : null;
  const height = entry && r.has(entry.body + 24, 4) ? r.u16(entry.body + 26) : null;
  return {
    fps: stts?.delta ? rational(mdhd.timescale, stts.delta) : null,
    frames: stts?.samples || null,
    duration: mdhd.duration ? mdhd.duration / mdhd.timescale : null,
    codec: entry?.type || null,
    width: width || null,
    height: height || null,
  };
}

/**
 * A QuickTime timecode track's description: its rate and drop-frame flag, and
 * where its sample — a single 32-bit frame number, the start timecode — is.
 */
function readTimecodeTrack(r, trak) {
  const stbl = path(r, trak, 'mdia', 'minf', 'stbl');
  const entry = stbl && firstSampleEntry(r, stbl);
  if (!entry || entry.type !== 'tmcd') return null;
  // SampleEntry (8), reserved (4), flags (4), timescale (4), frame duration
  // (4), frames per second as the timecode counts them (1).
  const o = entry.body + 8;
  if (!r.has(o, 17)) return null;
  const flags = r.u32(o + 4);
  const timescale = r.u32(o + 8);
  const frameDuration = r.u32(o + 12);
  const base = r.u8(o + 16);
  const offset = firstChunkOffset(r, stbl);
  if (offset == null || !base) return null;
  return { dropFrame: !!(flags & TMCD_DROP_FRAME), rate: rational(timescale, frameDuration), base, offset };
}

async function readExactly(readRange, start, end) {
  const bytes = await readRange(start, end);
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteLength < end - start) throw new Error('short read');
  return u8.byteLength === end - start ? u8 : u8.subarray(0, end - start);
}

/** Where the top-level `moov` is: { start, end, body }, or null. */
async function findMoov(readRange, size) {
  let o = 0;
  for (let i = 0; i < MAX_TOP_LEVEL_BOXES && o + 8 <= size; i++) {
    const head = new Reader(await readExactly(readRange, o, Math.min(o + 16, size)));
    let boxSize = head.u32(0);
    const type = head.type(4);
    let header = 8;
    if (boxSize === 1) {
      if (head.length < 16) return null;
      boxSize = head.u64(8);
      header = 16;
    } else if (boxSize === 0) {
      boxSize = size - o;
    }
    // The first box must look like one, or this is not an MP4 at all.
    if (i === 0 && !/^[\x20-\x7e]{4}$/.test(type)) return null;
    if (boxSize < header || o + boxSize > size) return null;
    if (type === 'moov') return { start: o, end: o + boxSize, header };
    o += boxSize;
  }
  return null;
}

/**
 * Probe a video file. `readRange(start, end)` returns the bytes [start, end);
 * `size` is the file's length in bytes.
 *
 * Returns null when this is not an ISO-BMFF/QuickTime file or has no video
 * track, else:
 *
 *   {
 *     fps:       { num, den } | null   exact, e.g. { num: 24000, den: 1001 }
 *     frames:    integer | null        video samples in the track
 *     duration:  seconds | null
 *     width, height: integers | null   the coded size
 *     codec:     'avc1' | 'apcn' | …
 *     tcStart:   integer               the start timecode, in frames at fps
 *                                      (0 when the file carries none)
 *     dropFrame: boolean
 *   }
 *
 * Throws only when a read fails; a file it cannot make sense of is null.
 */
export async function probeMp4(readRange, { size } = {}) {
  const total = Number(size);
  if (typeof readRange !== 'function' || !Number.isFinite(total) || total < 16) return null;

  const moovAt = await findMoov(readRange, total);
  if (!moovAt || moovAt.end - moovAt.start > MAX_MOOV_BYTES) return null;
  const r = new Reader(await readExactly(readRange, moovAt.start, moovAt.end));
  const moov = { type: 'moov', start: 0, end: r.length, body: moovAt.header };

  let video = null;
  let tmcd = null;
  try {
    for (const trak of children(r, moov.body, moov.end).filter((b) => b.type === 'trak')) {
      const handler = handlerOf(r, trak);
      if (handler === 'vide' && !video) video = readVideoTrack(r, trak);
      else if (handler === 'tmcd' && !tmcd) tmcd = readTimecodeTrack(r, trak);
    }
  } catch {
    // A DataView read past the end of a truncated box: not a file this can read.
    return null;
  }
  if (!video) return null;

  let tcStart = 0;
  let dropFrame = false;
  if (tmcd && tmcd.offset + 4 <= total) {
    try {
      const sample = new Reader(await readExactly(readRange, tmcd.offset, tmcd.offset + 4));
      const counted = sample.i32(0);
      dropFrame = tmcd.dropFrame;
      // The sample counts frames at the timecode track's own rate, which is
      // the video's in every file seen in practice. Where they differ, the
      // start is converted so it is still in frames of the picture.
      const same = !tmcd.rate || !video.fps
        || tmcd.rate.num * video.fps.den === video.fps.num * tmcd.rate.den;
      tcStart = counted > 0
        ? (same ? counted : Math.round((counted * video.fps.num * tmcd.rate.den) / (video.fps.den * tmcd.rate.num)))
        : 0;
    } catch {
      // A start timecode is a nicety; its absence is not a failed probe.
    }
  }

  return { ...video, tcStart, dropFrame };
}

/** A local File or Blob, for probing in the browser at upload. */
export function blobReader(blob) {
  return async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

/**
 * A readRange over HTTP range requests, for probing a stored object through a
 * presigned URL on the server. Resolves { readRange, size }.
 *
 * A server that ignores Range answers 200 with the whole object, which for a
 * master is gigabytes this would start downloading — so anything but a 206 is
 * refused and its body cancelled. `budget` caps the bytes one probe may pull.
 */
export async function rangeReader(url, { fetchImpl = globalThis.fetch, budget = MAX_MOOV_BYTES + 1024 * 1024 } = {}) {
  let spent = 0;
  const get = async (start, end) => {
    spent += end - start;
    if (spent > budget) throw new Error('probe read budget exceeded');
    const res = await fetchImpl(url, { headers: { range: `bytes=${start}-${end - 1}` } });
    if (res.status !== 206) {
      try { await res.body?.cancel?.(); } catch { /* nothing to release */ }
      throw new Error(`range request refused (HTTP ${res.status})`);
    }
    const total = Number(String(res.headers.get('content-range') || '').split('/')[1]);
    return { bytes: new Uint8Array(await res.arrayBuffer()), total };
  };
  const first = await get(0, 16);
  if (!Number.isFinite(first.total) || first.total <= 0) throw new Error('no object size in the range response');
  const size = first.total;
  return {
    size,
    readRange: async (start, end) => {
      const e = Math.min(end, size);
      // The walk always starts with the first 16 bytes; that request is paid for.
      if (start === 0 && e <= 16) return first.bytes.subarray(0, e);
      return (await get(start, e)).bytes;
    },
  };
}

/**
 * The frame model a probe contributes to a file's metadata, in the shape
 * mediaFacts (lib/media.js) validates. Empty when the rate is unknown: a
 * frame count or a start timecode means nothing without the rate it counts at.
 *
 * Width, height and duration are left to the caller — the browser's own
 * reading of those (display size, not coded) is what the rest of the app
 * already uses.
 */
export function probeMetadata(probe) {
  if (!probe || !probe.fps) return {};
  const out = { fps: { num: probe.fps.num, den: probe.fps.den }, tcStart: probe.tcStart || 0, dropFrame: !!probe.dropFrame };
  if (probe.frames) out.frames = probe.frames;
  return out;
}
