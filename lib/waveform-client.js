// lib/waveform-client.js — waveforms, drawn in the browser.
//
// A sound's shape (lib/waveform.js) is drawn wherever its bytes are:
//
//   upload    from the file in hand, while its bytes go up
//             (waveformForUpload, from lib/upload-client.js), and recorded
//             with the file;
//   backfill  for a sound with none — uploaded before waveforms existed, or
//             too long for the browser that uploaded it — by an editor's
//             browser as its tile comes near the screen or it is opened
//             (createWaveformBackfill): downloaded, drawn, and recorded
//             (PUT /api/files/<id>/waveform) for everyone after.
//
// Two ways to read a sound:
//
//   PCM      a WAV or an AIFF is its samples as they are, so it is read in
//            pieces and its loudness added up as they pass, never held
//            whole: a two-hour field recording costs what one piece does.
//            Past a couple of million frames only every so many is read
//            (STRIDE_FRAMES) — a bar's loudness does not need them all.
//   decoded  anything else (MP3, AAC, FLAC, Ogg) goes to the browser's own
//            decoder (decodeAudioData), which holds the whole sound as 32-bit
//            samples at its own rate while it works — 23 MB a minute of
//            48 kHz stereo. Past DECODE_MAX_SECONDS that is not done in a tab.
//
// One at a time for the page (inLane): three uploads of long recordings must
// not decode at once, and the backfill waits behind an upload's.

import { waveformFromSamples, waveformFromEnergy, encodeWaveform, WAVEFORM_BARS } from './waveform.js';
import { effectiveKind } from './media.js';
import { skippedRecently, rememberSkip } from './preview-wanted.js';
import { saveData, watchActivity, whenQuiet } from './backfill-quiet.js';

/** The longest sound given to the decoder whole: ~250 MB of samples at 48 kHz stereo. */
export const DECODE_MAX_SECONDS = 11 * 60;
// With no length known, a compressed file only this big: 11 minutes of a
// 64 kbps stream, the smallest bitrate anyone keeps music at.
const UNKNOWN_LENGTH_MAX_BYTES = 5 * 1024 * 1024;
/** The most the backfill downloads to draw a compressed sound. */
export const DECODED_FETCH_MAX_BYTES = 64 * 1024 * 1024;
/** …and to read a WAV or AIFF through, piece by piece. */
export const PCM_FETCH_MAX_BYTES = 256 * 1024 * 1024;

const PIECE_BYTES = 4 * 1024 * 1024;
const STRIDE_FRAMES = 2_000_000;

// ── one at a time ───────────────────────────────────────────────────────────
let lane = Promise.resolve();
function inLane(work) {
  const run = lane.then(work);
  lane = run.catch(() => {});
  return run;
}

// ── bytes in pieces ─────────────────────────────────────────────────────────

/** A Blob, `size` bytes at a time. */
async function* blobPieces(blob, size = PIECE_BYTES) {
  for (let at = 0; at < blob.size; at += size) {
    yield new Uint8Array(await blob.slice(at, Math.min(blob.size, at + size)).arrayBuffer());
  }
}

/** A response body as it arrives; a reader that stops early cancels the rest of the download. */
async function* streamPieces(body) {
  const reader = body.getReader();
  let done = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) { done = true; return; }
      if (next.value?.length) yield next.value;
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {});
  }
}

/** Exact reads and skips over pieces, for a header; runs of whatever is there, for samples. */
class Pieces {
  constructor(pieces) {
    this.it = pieces[Symbol.asyncIterator]();
    this.buf = new Uint8Array(0);
    this.at = 0;
    this.ended = false;
    /** Bytes consumed so far: where the next read starts in the file. */
    this.pos = 0;
  }

  async fill(n) {
    while (this.buf.length - this.at < n && !this.ended) {
      const { done, value } = await this.it.next();
      if (done) { this.ended = true; break; }
      const rest = this.buf.subarray(this.at);
      if (!rest.length) {
        this.buf = value;
      } else {
        const joined = new Uint8Array(rest.length + value.length);
        joined.set(rest);
        joined.set(value, rest.length);
        this.buf = joined;
      }
      this.at = 0;
    }
    return this.buf.length - this.at >= n;
  }

  /** The next `n` bytes, or null when the file ends first. */
  async read(n) {
    if (!(await this.fill(n))) return null;
    const out = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    this.pos += n;
    return out;
  }

  async skip(n) {
    let left = n;
    while (left > 0) {
      const have = this.buf.length - this.at;
      if (have >= left) { this.at += left; this.pos += left; return true; }
      this.at += have;
      this.pos += have;
      left -= have;
      if (!(await this.fill(1))) return false;
    }
    return true;
  }

  /** The next run of bytes there are, up to `max`, or null at the end. */
  async take(max) {
    if (!(await this.fill(1))) return null;
    const n = Math.min(max, this.buf.length - this.at);
    const out = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    this.pos += n;
    return out;
  }

  close() { this.it.return?.().catch?.(() => {}); }
}

// ── PCM: WAV and AIFF ───────────────────────────────────────────────────────

const ascii = (b, at = 0, n = 4) => String.fromCharCode(...b.subarray(at, at + n));
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/**
 * How a PCM file's samples are laid out — { channels, width (bytes a sample),
 * float, littleEndian, unsigned8, frames } — with `src` left at the first
 * sample; or null for anything else: not a WAV or AIFF, or one whose samples
 * are compressed (ADPCM, µ-law, an MP3 in a WAV), which goes to the decoder.
 * `total` is the file's size, for a WAV that never said how long it is.
 */
export async function pcmLayout(src, total = 0) {
  const head = await src.read(12);
  if (!head) return null;
  const outer = ascii(head, 0);
  const form = ascii(head, 8);
  if ((outer === 'RIFF' || outer === 'RF64') && form === 'WAVE') return wavLayout(src, total, outer === 'RF64');
  if (outer === 'FORM' && (form === 'AIFF' || form === 'AIFC')) return aiffLayout(src, form === 'AIFC');
  return null;
}

async function wavLayout(src, total, rf64) {
  let fmt = null;
  let longData = null;
  for (let chunk = 0; chunk < 64; chunk++) {
    const h = await src.read(8);
    if (!h) return null;
    const id = ascii(h, 0);
    let size = view(h).getUint32(4, true);
    if (id === 'ds64' || id === 'fmt ') {
      const b = await src.read(size);
      if (!b) return null;
      if (size & 1) await src.skip(1);
      const d = view(b);
      if (id === 'ds64') {
        if (size >= 16) longData = Number(d.getBigUint64(8, true));
        continue;
      }
      if (size < 16) return null;
      let format = d.getUint16(0, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format leads its sub-format GUID.
      if (format === 0xfffe && size >= 26) format = d.getUint16(24, true);
      if (format !== 1 && format !== 3) return null;
      const channels = d.getUint16(2, true);
      fmt = { channels, width: channels ? d.getUint16(12, true) / channels : 0, float: format === 3 };
      continue;
    }
    if (id === 'data') {
      if (!fmt) return null;
      if (rf64 && size === 0xffffffff && longData != null) size = longData;
      // Written as it was recorded, a WAV may say nothing of its length (0)
      // or everything (the most it can): then it runs to the end of the file.
      if ((size === 0 || size === 0xffffffff) && total > src.pos) size = total - src.pos;
      return sampleLayout({ ...fmt, bytes: size, littleEndian: true, unsigned8: true });
    }
    if (!(await src.skip(size + (size & 1)))) return null;
  }
  return null;
}

async function aiffLayout(src, aifc) {
  let comm = null;
  for (let chunk = 0; chunk < 64; chunk++) {
    const h = await src.read(8);
    if (!h) return null;
    const id = ascii(h, 0);
    const size = view(h).getUint32(4, false);
    if (id === 'COMM') {
      const b = await src.read(size);
      if (!b || size < 18) return null;
      if (size & 1) await src.skip(1);
      const d = view(b);
      comm = {
        channels: d.getUint16(0, false),
        frames: d.getUint32(2, false),
        bits: d.getUint16(6, false),
        type: aifc && size >= 22 ? ascii(b, 18) : 'NONE',
      };
      continue;
    }
    if (id === 'SSND') {
      if (!comm) return null;
      const b = await src.read(8);
      if (!b) return null;
      const offset = view(b).getUint32(0, false);
      if (offset && !(await src.skip(offset))) return null;
      const type = comm.type.toLowerCase();
      const float = type === 'fl32' || type === 'fl64';
      if (!float && type !== 'none' && type !== 'twos' && type !== 'sowt') return null;
      const width = float ? (type === 'fl64' ? 8 : 4) : Math.ceil(comm.bits / 8);
      let bytes = Math.max(0, size - 8 - offset);
      if (comm.frames) bytes = Math.min(bytes, comm.frames * comm.channels * width);
      return sampleLayout({ channels: comm.channels, width, float, bytes, littleEndian: type === 'sowt', unsigned8: false });
    }
    if (!(await src.skip(size + (size & 1)))) return null;
  }
  return null;
}

function sampleLayout({ channels, width, float, bytes, littleEndian, unsigned8 }) {
  if (!Number.isInteger(channels) || channels < 1 || channels > 64) return null;
  if (float ? width !== 4 && width !== 8 : ![1, 2, 3, 4].includes(width)) return null;
  const frames = Math.floor(bytes / (channels * width));
  return frames > 0 ? { channels, width, float, littleEndian, unsigned8, frames } : null;
}

/** A function reading one sample at a byte offset of a DataView, in the layout's own unit. */
function sampleReader({ width, float, littleEndian: le, unsigned8 }) {
  if (float) return width === 8 ? (d, i) => d.getFloat64(i, le) : (d, i) => d.getFloat32(i, le);
  switch (width) {
    case 1: return unsigned8 ? (d, i) => d.getUint8(i) - 128 : (d, i) => d.getInt8(i);
    case 2: return (d, i) => d.getInt16(i, le);
    case 3: return le
      ? (d, i) => d.getUint8(i) | (d.getUint8(i + 1) << 8) | (d.getInt8(i + 2) << 16)
      : (d, i) => (d.getInt8(i) << 16) | (d.getUint8(i + 1) << 8) | d.getUint8(i + 2);
    default: return (d, i) => d.getInt32(i, le);
  }
}

/** Loudness bars from the samples after a header (pcmLayout), read piece by piece. */
export async function pcmBars(src, layout, bars = WAVEFORM_BARS) {
  const { channels, width, frames } = layout;
  const frameBytes = channels * width;
  const n = Math.max(1, Math.min(bars, frames));
  const sums = new Float64Array(n);
  const counts = new Float64Array(n);
  const stride = Math.max(1, Math.floor(frames / STRIDE_FRAMES));
  const read = sampleReader(layout);
  let first = 0; // the frame the next piece starts with
  let carry = null; // the start of a frame the last piece cut through
  try {
    while (first < frames) {
      const piece = await src.take(PIECE_BYTES);
      if (!piece) break;
      let bytes = piece;
      if (carry) {
        bytes = new Uint8Array(carry.length + piece.length);
        bytes.set(carry);
        bytes.set(piece, carry.length);
      }
      const whole = Math.floor(bytes.length / frameBytes);
      const end = Math.min(first + whole, frames);
      const d = view(bytes);
      for (let f = Math.ceil(first / stride) * stride; f < end; f += stride) {
        const at = (f - first) * frameBytes;
        let sum = 0;
        for (let c = 0; c < channels; c++) {
          const v = read(d, at + c * width);
          sum += v * v;
        }
        const bar = Math.min(n - 1, Math.floor((f * n) / frames));
        sums[bar] += sum;
        counts[bar] += channels;
      }
      first += whole;
      carry = bytes.length > whole * frameBytes ? bytes.slice(whole * frameBytes) : null;
    }
  } finally {
    src.close();
  }
  return waveformFromEnergy(sums, counts);
}

// ── decoded: everything else ────────────────────────────────────────────────

/** Whether a compressed sound is short enough to hand the decoder whole. */
function decodable(bytes, duration) {
  const seconds = Number(duration);
  if (Number.isFinite(seconds) && seconds > 0) return seconds <= DECODE_MAX_SECONDS;
  return Number(bytes) > 0 && Number(bytes) <= UNKNOWN_LENGTH_MAX_BYTES;
}

async function decodedBars(blob) {
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline) return null;
  // Decoded at a low rate: the samples it hands back are a sixth of the
  // file's own, and loudness needs no treble.
  let ctx;
  try { ctx = new Offline(1, 1, 8000); } catch { ctx = new Offline(1, 1, 22050); }
  const data = await blob.arrayBuffer();
  const audio = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(data, resolve, reject);
    p?.then?.(resolve, reject);
  });
  const channels = [];
  for (let i = 0; i < audio.numberOfChannels; i++) channels.push(audio.getChannelData(i));
  return waveformFromSamples(channels);
}

/** A waveform string from a sound's bytes in hand, or null for one this browser cannot draw. */
async function waveformOfBlob(blob, { duration } = {}) {
  const src = new Pieces(blobPieces(blob));
  const layout = await pcmLayout(src, blob.size);
  if (layout) return encodeWaveform(await pcmBars(src, layout));
  src.close();
  if (!decodable(blob.size, duration)) return null;
  return encodeWaveform(await decodedBars(blob));
}

/**
 * The waveform of a sound being uploaded, drawn from the file in hand:
 * `duration` is what the browser read of its length (audioLength), which
 * decides whether a compressed one is decoded. Null for anything it cannot
 * draw. Never throws: an upload never fails for want of a waveform.
 */
export function waveformForUpload(file, { duration } = {}) {
  return inLane(() => waveformOfBlob(file, { duration })).catch(() => null);
}

// ── backfill ────────────────────────────────────────────────────────────────

const PCM_NAME = /\.(wav|wave|bwf|aif|aiff|aifc)$/i;
const PCM_MIME = /^audio\/(x-)?(wav|wave|aiff|aifc)$|^audio\/vnd\.wave/i;
const looksPcm = (file) => PCM_NAME.test(String(file?.name || '')) || PCM_MIME.test(String(file?.mime || ''));

/**
 * Whether the backfill would draw this file's waveform: a sound in the
 * bucket, with none, that this page may be able to record one for, and not
 * too big to download for it.
 */
export function waveformWanted(file) {
  if (!file?.id || file.storage !== 's3' || !file.url || file.metadata?.waveform) return false;
  if (effectiveKind(file) !== 'audio' || file.can?.edit === false) return false;
  const size = Number(file.size);
  if (!(size > 0)) return false;
  if (looksPcm(file)) return size <= PCM_FETCH_MAX_BYTES;
  return size <= DECODED_FETCH_MAX_BYTES && decodable(size, file.metadata?.duration);
}

/** A stored sound's waveform, drawn from a download of it. */
async function waveformOfStored(file) {
  const res = await fetch(file.url, { mode: 'cors', cache: 'no-store' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  if (looksPcm(file)) {
    const total = Number(res.headers.get('content-length')) || Number(file.size) || 0;
    const src = new Pieces(streamPieces(res.body));
    const layout = await pcmLayout(src, total);
    if (layout) return encodeWaveform(await pcmBars(src, layout));
    src.close();
    return null;
  }
  return waveformOfBlob(await res.blob(), { duration: file.metadata?.duration });
}

/** Record a waveform for `file` → the row as the server has it now, or null. */
export async function recordWaveform(file, waveform) {
  const r = await fetch(`/api/files/${file.id}/waveform`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ waveform, contentHash: file.contentHash || undefined }),
  });
  if (!r.ok) return null;
  const body = await r.json().catch(() => ({}));
  return body.file || null;
}

/**
 * The waveform backfill: `request(file)` for a sound seen with none. Each is
 * drawn once the page is quiet (lib/backfill-quiet.js), one at a time, and
 * `onReady(row)` gets the row with its waveform. A file that cannot have one
 * — refused, undrawable, failed — is not asked about again for a week
 * (lib/preview-wanted.js), as a thumbnail is not.
 */
export function createWaveformBackfill(onReady) {
  const seen = new Set();
  const queue = [];
  let running = false;
  watchActivity();

  async function run() {
    running = true;
    while (queue.length) {
      const file = queue.shift();
      await whenQuiet();
      try {
        // The listing's `can` says per file; without it, asked before the
        // download rather than learned from the PUT after it.
        if (file.can?.edit !== true) {
          const may = await fetch(`/api/files/${file.id}/waveform`, { cache: 'no-store' });
          if (!may.ok) { rememberSkip(file.id, 'wave'); continue; }
        }
        const waveform = await inLane(() => waveformOfStored(file));
        const saved = waveform ? await recordWaveform(file, waveform) : null;
        if (saved) onReady(saved);
        else rememberSkip(file.id, 'wave');
      } catch {
        rememberSkip(file.id, 'wave');
      }
    }
    running = false;
  }

  return (file) => {
    if (!waveformWanted(file) || seen.has(file.id)) return;
    if (saveData() || skippedRecently(file.id, 'wave')) return;
    seen.add(file.id);
    queue.push(file);
    if (!running) run();
  };
}
