// lib/video-convert.js — a video's "Download as…" copy, made in the browser:
// the original read from its signed address, decoded, turned upright,
// scaled and — an HDR one — taken to SDR, encoded as H.264, its sound copied
// or made AAC, and written as an MP4. mediabunny (npm, MPL-2.0, used as it
// is) reads and writes the containers and drives the browser's WebCodecs;
// what is made — sizes, codec strings, bitrates, where it is held — is lib/
// video-formats.js's plan.
//
// For either side of a worker: lib/video-convert.worker.js runs a VideoJob
// off the page's thread where the browser has WebCodecs in workers, and
// lib/video-client.js runs one on the page where it has them only there.
//
// Reading. The bucket's CORS rule lets the page GET and exposes only ETag
// (lib/storage-cors.js). That is enough to read the original in pieces:
// mediabunny asks for `Range: bytes=N-` (allowed: the rule allows any
// request header) and learns the file's length from a 206's Content-Length,
// which every browser lets a page read, without Content-Range. So a 40 GB
// master is read once, front to back, a few megabytes held at a time, and
// its index (a `moov` at the end) found by a jump. Storage that ignores
// ranges is read whole first, up to a cap. Past the HTTP cache, as the
// pictures are (a copy the player left there has no CORS headers); signed
// again once if the address has expired meanwhile; a request that fails, or
// that the storage answers with a passing 5xx, tried three times more.
//
// Colour. Every frame that is scaled or turned is drawn onto a 2D canvas,
// which is colour-managed: an HDR frame (HLG, PQ — an iPhone's Dolby Vision
// decodes as its HLG base) is tone-mapped by the browser to SDR, as its own
// player shows it on an SDR screen, and the copy is SDR BT.709. HDR is never
// handed to the encoder as it is: Chrome accepts a 10-bit HLG frame and
// writes 8-bit H.264 tagged HLG — banded, and washed out in every player
// that ignores the tag — so an HDR frame goes through the canvas even at the
// source's own size. An SDR frame already the copy's size and upright is
// passed to the encoder as decoded, without the round trip through RGB.
//
// Writing. MP4 with its index at the end (fastStart: false): written as it
// is made, in 16 MB pieces, with one small write back to the start to seal
// the media box — into memory (memorySink, up to MEMORY_MAX_BYTES), or into
// a file the person chose (fileSink, the File System Access API).
// Nothing of the original's own metadata — its location among it — is
// copied.

import {
  Input, MP4, QTFF, MATROSKA, WEBM, MPEG_TS, UrlSource, BlobSource, Output, Mp4OutputFormat, StreamTarget,
  VideoSample, VideoSampleSink, VideoSampleSource, AudioSampleSink, AudioSampleSource, EncodedPacketSink,
  EncodedAudioPacketSource, Quality, canEncodeVideo, canEncodeAudio,
} from 'mediabunny';
import {
  VIDEO_TARGETS, H264_MODES, videoEncoderConfig, h264CodecString, audioPlan, sourceRead,
  MEMORY_MAX_BYTES, WHOLE_READ_MAX_BYTES,
} from './video-formats.js';
import { fmtSize } from './media.js';
import { toneMapper, toneMappable, canToneMap, TONE_MAPPED_COLOUR } from './hdr-tonemap.js';
import { moovOffset, withAacRollGroups } from './mp4-roll.js';
import { downscalePlan } from './poster.js';

/**
 * Why a copy could not be made. `code`: 'read' (the original could not be
 * read), 'range' (storage that cannot be read in pieces, and too large to
 * read whole), 'format' (not a container this reads), 'novideo', 'size' (the
 * copy outgrew memory), 'write' (the file could not be written), 'convert'
 * (decoding or encoding stopped), 'unsupported' (no WebCodecs here).
 */
export class VideoConvertError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VideoConvertError';
    this.code = code;
  }
}

const aborted = () => new DOMException('The download was cancelled.', 'AbortError');
// The containers a video comes in (MP4, MOV, MKV, WebM, a camcorder's MPEG
// transport stream) — and only those, so the rest of mediabunny's readers
// (HLS, sound-only formats) are not in the worker's bundle.
const VIDEO_FORMATS = [MP4, QTFF, MATROSKA, WEBM, MPEG_TS];
const CHUNK_BYTES = 16 * 1024 * 1024;
/** Audio is read at most this far ahead of the video, so the two are laid out together in the file. */
const AUDIO_LEAD_SECONDS = 5;
/** A canvas's frames, as the H.264 encoders write them: sRGB-encoded, BT.709 matrix, limited range. */
const CANVAS_COLOUR = Object.freeze({ primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: false });
/** An SDR source's own colour, for frames passed on as decoded; BT.709 limited where it says nothing. */
const decodedColour = (cs) => ({
  primaries: cs?.primaries || 'bt709',
  transfer: cs?.transfer || 'bt709',
  matrix: cs?.matrix || 'bt709',
  fullRange: cs?.fullRange === true,
});
/** Progress is reported at most this often. */
const PROGRESS_MS = 200;
/** A copy that has not moved on by a frame in this long has stopped. */
const STALL_MS = 90 * 1000;
/** How much AAC before the start a copy keeps: an encoder's priming, a few packets. */
const PRIMING_SECONDS = 0.25;
/** HDR frames taken to SDR on the GPU at once, so their read back overlaps the next (lib/hdr-tonemap.js). */
const TONE_MAP_DEPTH = 3;
/** On the page, the thread is given back at least this often. */
const PAGE_SLICE_MS = 40;

/** Whether this context can make a copy at all: WebCodecs, and a 2D OffscreenCanvas or document canvas to scale on. */
export function canConvertHere() {
  return typeof VideoDecoder === 'function' && typeof VideoEncoder === 'function' && typeof VideoFrame === 'function'
    && (typeof OffscreenCanvas === 'function' || typeof document !== 'undefined');
}

// ── Reading the original ───────────────────────────────────────────────────

const REQUEST = Object.freeze({ mode: 'cors', cache: 'no-store', credentials: 'omit' });

/**
 * How someone signed in has the original signed again: their file's record,
 * re-read from `url` (same origin, their session) for its `url`. Null — no
 * re-signing — for a share link's guest, whose page signed it for six hours.
 */
export function refresher(url) {
  return url ? async () => {
    const r = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    return r.ok ? (await r.json())?.file?.url || null : null;
  } : null;
}

/**
 * fetch against the address in `state.url`, whatever mediabunny asks for;
 * signed again once through `state.refresh` when the storage says it has
 * expired (403, or 400 for a malformed date).
 */
function signedFetch(state) {
  return async (_url, init = {}) => {
    const r = await fetch(state.url, init);
    if ((r.status !== 403 && r.status !== 400) || !state.refresh || state.refreshed) return r;
    state.refreshed = true;
    const again = await state.refresh().catch(() => null);
    if (!again || again === state.url) return r;
    try { await r.body?.cancel(); } catch { /* already closed */ }
    state.url = again;
    return fetch(state.url, init);
  };
}

// Three tries more after a failure, a few seconds apart: a network that has
// gone is reported rather than waited on for ever (mediabunny's default
// retries without end, and cannot tell a CORS refusal in a worker).
const retryDelay = (attempts) => (attempts <= 3 ? 2 ** (attempts - 1) : null);

/**
 * A server's passing failure — S3 answers 500 and 503 now and then, and asks
 * to be tried again — thrown as a network error is, which is what mediabunny
 * retries (an answer that is not OK it gives up on at once, and a copy of a
 * long video makes many requests).
 */
const retryingServerErrors = (fetchFn) => async (url, init) => {
  const r = await fetchFn(url, init);
  if (r.status < 500) return r;
  try { await r.body?.cancel(); } catch { /* already closed */ }
  throw new Error(`The storage answered HTTP ${r.status}.`);
};

/**
 * Whether the storage answers a range request here — a byte of it, so no
 * more is sent than is read — and the file's length where the answer says:
 * a whole answer's Content-Length; a partial one's Content-Range where the
 * bucket exposes it (the page otherwise knows the size from the file's row).
 */
async function rangeCheck(state, signal) {
  let r;
  try {
    r = await signedFetch(state)(null, { ...REQUEST, headers: { Range: 'bytes=0-0' }, signal });
  } catch (e) {
    if (signal?.aborted) throw aborted();
    throw new VideoConvertError('read', 'The original could not be read from storage.');
  }
  try { await r.body?.cancel(); } catch { /* already closed */ }
  if (!r.ok) throw new VideoConvertError('read', `The original could not be read (HTTP ${r.status}).`);
  const range = r.status === 206;
  const total = range
    ? Number((r.headers.get('content-range') || '').split('/')[1]) || null
    : Number(r.headers.get('content-length')) || null;
  return { range, total };
}

/** The whole original as a Blob (the browser's, not the page's memory), with progress; refused past `max`. */
async function fetchWhole(state, { signal, onProgress, max }) {
  let r;
  try {
    r = await signedFetch(state)(null, { ...REQUEST, signal });
  } catch {
    if (signal?.aborted) throw aborted();
    throw new VideoConvertError('read', 'The original could not be read from storage.');
  }
  if (!r.ok) throw new VideoConvertError('read', `The original could not be read (HTTP ${r.status}).`);
  const total = Number(r.headers.get('content-length')) || 0;
  if (total > max) {
    try { await r.body?.cancel(); } catch { /* gone */ }
    throw new VideoConvertError('range', 'This file is too large to read whole in the browser.');
  }
  if (!r.body) return r.blob();
  const reader = r.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (got > max) {
      try { await reader.cancel(); } catch { /* gone */ }
      throw new VideoConvertError('range', 'This file is too large to read whole in the browser.');
    }
    parts.push(value);
    onProgress?.({ phase: 'read', fraction: total ? Math.min(1, got / total) : null });
  }
  return new Blob(parts);
}

// ── Writing the copy ───────────────────────────────────────────────────────

/**
 * Bytes laid out as they were written at positions — the pieces kept as they
 * come, a write back over earlier bytes landing inside them, a gap filled
 * with zeros — readable back.
 */
function positionedBytes() {
  const parts = [];
  const starts = [];
  let size = 0;
  const at = (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  const append = (bytes) => {
    starts.push(size);
    parts.push(bytes);
    size += bytes.byteLength;
  };
  return {
    parts,
    get size() { return size; },
    write(data, position, from = 0) {
      if (position < from) {
        if (position + data.byteLength <= from) return;
        data = data.subarray(from - position);
        position = from;
      }
      const rel = position - from;
      if (rel > size) append(new Uint8Array(rel - size));
      let pos = rel;
      let off = 0;
      while (off < data.byteLength && pos < size) {
        const i = at(pos);
        const part = parts[i];
        const inside = pos - starts[i];
        const n = Math.min(part.byteLength - inside, data.byteLength - off);
        part.set(data.subarray(off, off + n), inside);
        pos += n;
        off += n;
      }
      if (off < data.byteLength) append(off ? data.subarray(off) : data);
    },
    read(position, length) {
      const out = new Uint8Array(Math.max(0, Math.min(length, size - position)));
      let pos = position;
      let off = 0;
      while (off < out.length) {
        const i = at(pos);
        const inside = pos - starts[i];
        const n = Math.min(parts[i].byteLength - inside, out.length - off);
        out.set(parts[i].subarray(inside, inside + n), off);
        pos += n;
        off += n;
      }
      return out;
    },
    truncate(position) {
      while (parts.length && starts[parts.length - 1] >= position) { parts.pop(); starts.pop(); }
      if (parts.length) {
        const last = parts.length - 1;
        parts[last] = parts[last].subarray(0, position - starts[last]);
      }
      size = Math.min(size, position);
    },
  };
}

/** The file's `moov` with roll groups added (lib/mp4-roll.js), from its first bytes and a way to read the rest; null when it needs none. */
function sealedMoov(head, read, size) {
  const at = moovOffset(head);
  if (at == null || at >= size) return null;
  const moov = read(at, size - at);
  const patched = withAacRollGroups(moov);
  return patched === moov ? null : { at, bytes: patched };
}

/**
 * A sink in memory: the MP4 as it is written, refused past `maxBytes`.
 * `seal()` once the muxer is done (the moov made right — lib/mp4-roll.js);
 * `blob()` then hands the pieces to the browser as one file.
 */
export function memorySink(maxBytes = MEMORY_MAX_BYTES) {
  const file = positionedBytes();
  const writable = new WritableStream({
    write({ data, position }) {
      file.write(data, position);
      if (file.size > maxBytes) {
        throw new VideoConvertError('size', `The copy grew past ${fmtSize(maxBytes)}, more than this browser can hold. Download the original instead.`);
      }
    },
  });
  return {
    writable,
    get size() { return file.size; },
    finishing() {},
    async seal() {
      const sealed = sealedMoov(file.read(0, 64), file.read, file.size);
      if (!sealed) return;
      file.truncate(sealed.at);
      file.write(sealed.bytes, sealed.at);
    },
    blob: () => new Blob(file.parts, { type: 'video/mp4' }),
  };
}

/**
 * A sink into a file being written (a FileSystemWritableFileStream): what is
 * written goes to disk as it comes. The muxer's close does not commit it:
 * `seal()` does, once the moov is made right — for which what is written
 * after `finishing()` (the moov among it) is kept a copy of. `discard()`
 * throws away what was written: the stream is aborted, never closed, since
 * closing it commits the file as it stands.
 */
export function fileSink(fileWritable) {
  const writer = fileWritable.getWriter();
  let discarded = false;
  let size = 0;
  const head = new Uint8Array(64);
  let tail = null;
  const writable = new WritableStream({
    async write(chunk) {
      const { data, position } = chunk;
      if (position < head.length) head.set(data.subarray(0, Math.min(data.byteLength, head.length - position)), position);
      tail?.write(data.slice(), position, tail.from);
      try {
        await writer.write(chunk);
      } catch {
        throw new VideoConvertError('write', 'The copy could not be written to disk. Is there room on it?');
      }
      size = Math.max(size, position + data.byteLength);
    },
    close: () => {},
    abort: () => writer.abort().catch(() => {}),
  });
  return {
    writable,
    get size() { return size; },
    finishing() {
      // The muxer writes the moov last, after all the media: from here on.
      tail = Object.assign(positionedBytes(), { from: size - (size % (16 * 1024 * 1024)) });
    },
    async seal() {
      if (discarded) return;
      const from = tail?.from ?? size;
      const moovAt = moovOffset(head);
      const sealed = tail && moovAt != null && moovAt >= from ? sealedMoov(head, (p, n) => tail.read(p - from, n), size) : null;
      try {
        if (sealed) {
          await writer.write({ type: 'write', data: sealed.bytes, position: sealed.at });
          size = sealed.at + sealed.bytes.byteLength;
        }
        await writer.close();
      } catch {
        throw new VideoConvertError('write', 'The copy could not be written to disk. Is there room on it?');
      }
    },
    discard: () => {
      discarded = true;
      return writer.abort().catch(() => {});
    },
  };
}

// ── Frames ─────────────────────────────────────────────────────────────────

/**
 * Frames drawn at the copy's `width` × `height`: turned by their rotation
 * (and flip), shrunk by halves at most per step (lib/poster.js
 * downscalePlan), onto 2D canvases kept for the whole copy. Bilinear
 * smoothing: at no more than 2x a step it averages as a box filter would,
 * and WebKit's 'high' takes two and a half times as long (4K to 1080p: 72
 * frames a second against 29) for a difference no encoder keeps. The
 * canvases are sRGB and colour-managed: an HDR frame the browser knows is
 * HDR is tone-mapped as it is first drawn. `draw(sample)` returns the canvas
 * holding the frame — until the next draw.
 */
function frameScaler(width, height) {
  const canvases = new Map();
  const canvasOf = (w, h) => {
    const key = `${w}x${h}`;
    if (!canvases.has(key)) {
      const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'low';
      canvases.set(key, { canvas, ctx });
    }
    return canvases.get(key);
  };
  return {
    draw(sample) {
      const steps = downscalePlan({ width: sample.displayWidth, height: sample.displayHeight }, { width, height });
      let from = null;
      for (const step of steps) {
        const { canvas, ctx } = canvasOf(step.width, step.height);
        if (from) ctx.drawImage(from, 0, 0, step.width, step.height);
        else sample.draw(ctx, 0, 0, step.width, step.height);
        from = canvas;
      }
      return from;
    },
    close() {
      for (const { canvas } of canvases.values()) { canvas.width = 0; canvas.height = 0; }
      canvases.clear();
    },
  };
}

// ── The job ────────────────────────────────────────────────────────────────

const yieldToPage = () => new Promise((resolve) => {
  if (typeof MessageChannel === 'function') {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
    ch.port2.postMessage(0);
  } else {
    setTimeout(resolve, 0);
  }
});

/**
 * One file, looked at and then — perhaps — converted. `probe()` first, which
 * opens the original; `convert(plan)` then reuses what it read. `cancel()`
 * stops everything under way: the reads, the decoders and encoders, the
 * writing. `onPage`: running on the page's own thread, which is given back
 * every PAGE_SLICE_MS.
 */
export class VideoJob {
  constructor({ onPage = false } = {}) {
    this.onPage = onPage;
    this.input = null;
    this.output = null;
    this.sink = null;
    this.controller = new AbortController();
    this.cancelled = false;
  }

  /**
   * Opens the original at `src` (`bytes` long, if known) and says what it is
   * and what this browser can make of it — lib/video-formats.js reads it:
   *
   *   { ok: true, read: 'range' | 'whole', bytes,
   *     video: { codec, codecString, width, height, rotation, hdr, fps,
   *              frameRate, duration, bitrate, decode },
   *     audio: { codec, codecString, channels, sampleRate, bitrate, decode } | null,
   *     encode: { [target id]: the codec string this browser encodes it with, or false },
   *     h264: { profile, latencyMode } its encoder makes every frame in (h264Mode), or null,
   *     aac: whether AAC can be made of the sound (null when it need not be) }
   *
   * or { ok: false, reason } — 'read', 'range', 'format', 'novideo',
   * 'unsupported'. `refresh()` signs the address again.
   */
  async probe({ src, bytes = null, refresh = null, onProgress = null }) {
    if (!canConvertHere()) return { ok: false, reason: 'unsupported' };
    const { signal } = this.controller;
    this.state = { url: src, refresh, refreshed: false };
    let check;
    try {
      check = await rangeCheck(this.state, signal);
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      return { ok: false, reason: e?.code || 'read' };
    }
    const size = Number(bytes) > 0 ? Number(bytes) : check.total;
    const read = sourceRead({ range: check.range, bytes: size });
    if (!read) return { ok: false, reason: 'range' };
    let source;
    if (read === 'range') {
      source = new UrlSource(this.state.url, { requestInit: REQUEST, fetchFn: retryingServerErrors(signedFetch(this.state)), getRetryDelay: retryDelay });
    } else {
      try {
        source = new BlobSource(await fetchWhole(this.state, { signal, onProgress, max: WHOLE_READ_MAX_BYTES }));
      } catch (e) {
        if (e?.name === 'AbortError' || signal.aborted) throw aborted();
        return { ok: false, reason: e?.code || 'read' };
      }
    }
    this.input = new Input({ source, formats: VIDEO_FORMATS });
    let track;
    try {
      track = await this.input.getPrimaryVideoTrack();
    } catch (e) {
      if (signal.aborted) throw aborted();
      return { ok: false, reason: e?.name === 'UnsupportedInputFormatError' ? 'format' : 'read' };
    }
    if (!track) return { ok: false, reason: 'novideo' };
    const audioTrack = await track.getPrimaryPairableAudioTrack().catch(() => null)
      || await this.input.getPrimaryAudioTrack().catch(() => null);
    this.tracks = { video: track, audio: audioTrack };

    const [codec, codecString, width, height, rotation, hdr, colorSpace, decode, duration, stats, rates] = await Promise.all([
      track.getCodec(), track.getCodecParameterString(), track.getDisplayWidth(), track.getDisplayHeight(),
      track.getRotation(), track.hasHighDynamicRange(), track.getColorSpace().catch(() => ({})), track.canDecode(),
      this.input.computeDuration([track]).catch(() => null),
      // From the first packets — for an MP4, its index, not its media.
      track.computePacketStats(120).catch(() => null),
      track.computeFrameRateMetrics({ targetPacketCount: 256 }).catch(() => null),
    ]);
    // How this browser hands an HDR video's frames over decides how they are
    // taken to SDR: by its own canvas, or by lib/hdr-tonemap.js.
    const transfer = colorSpace?.transfer === 'hlg' || colorSpace?.transfer === 'pq' ? colorSpace.transfer : null;
    const hdrPath = hdr && decode ? await hdrRoute(track, transfer) : null;
    const audio = audioTrack ? await describeAudio(audioTrack) : null;
    // The source's own bitrate, its sound left out, from the file's size:
    // what a copy is never given more than (lib/video-formats.js).
    const whole = Number(size) > 0 && duration > 0 ? (size * 8) / duration : null;
    const bitrate = whole
      ? Math.max(whole - (audio?.bitrate || 0), whole * 0.5)
      : stats?.averageBitrate > 0 ? Math.round(stats.averageBitrate) : null;
    const fps = rates?.bestGuessFrameRate || stats?.averagePacketRate || null;
    const video = {
      codec, codecString, width, height, rotation, hdr: hdr === true, transfer, hdrPath, decode: decode === true,
      fps: fps > 0 ? +fps.toFixed(3) : null,
      // The lattice its frames sit on, when they sit on one (not a variable
      // frame rate): the copy is written on it, and the encoder told it.
      frameRate: rates?.underlyingFrameRate > 0 ? rates.underlyingFrameRate : null,
      duration: duration > 0 ? duration : null,
      bitrate,
    };
    // What this browser encodes, at exactly what each target would ask —
    // once its encoder has been seen to make every frame, and in what
    // profile and mode (h264Mode).
    const h264 = await h264Mode();
    const encode = {};
    for (const t of VIDEO_TARGETS) {
      const config = videoEncoderConfig(video, t.id, { profile: h264?.profile });
      if (config) encode[t.id] = h264 && (await encodes(config, h264.latencyMode)) ? config.codec : false;
    }
    const wanted = audio && audioPlan(audio, { aacEncode: true });
    const aac = wanted?.mode === 'encode'
      ? await canEncodeAudio('aac', {
        numberOfChannels: wanted.numberOfChannels, sampleRate: wanted.sampleRate, quality: new Quality({ bitrate: wanted.bitrate }),
      }).catch(() => false)
      : null;
    return { ok: true, read, bytes: size || null, video, audio, encode, h264, aac };
  }

  /**
   * Makes the copy `plan` describes (lib/video-formats.js videoPlan), into
   * `sink` (memorySink or fileSink). `onProgress({ phase: 'convert',
   * fraction, done })` — `done` seconds of the video made. Resolves
   * { bytes } once the file is sealed.
   */
  async convert(plan, { sink, onProgress = null }) {
    if (!this.input || !this.tracks) throw new VideoConvertError('read', 'The original has not been opened.');
    const { video: videoTrack } = this.tracks;
    const audioTrack = plan.audio?.mode === 'none' ? null : this.tracks.audio;
    this.sink = sink;
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(sink.writable, { chunked: true, chunkSize: CHUNK_BYTES }),
    });
    this.output = output;
    // What the copy's pixels are, for its `colr` box — said here, not taken
    // from the encoder, whose word WebKit gets wrong (it reports full range
    // for the limited range it writes, and a player that believed it would
    // show grey blacks). A frame from a canvas is sRGB, and both engines
    // encode it BT.709, limited range (measured); one passed on as decoded
    // is what the source says it is.
    let colour = null;
    const videoSource = new VideoSampleSource({
      codec: 'avc',
      fullCodecString: plan.codec,
      quality: new Quality({ bitrate: plan.bitrate }),
      keyFrameInterval: plan.keyFrameSeconds,
      // The mode the probe saw this browser's encoder make frames in (h264LatencyMode).
      latencyMode: plan.latencyMode === 'realtime' ? 'realtime' : 'quality',
      // Every frame is made the copy's size; one that is not (a stream that
      // changes size part way) is fitted into it, never stretched.
      sizeChangeBehavior: 'contain',
      onEncodedPacket: (_packet, meta) => {
        if (meta?.decoderConfig && colour) meta.decoderConfig.colorSpace = { ...colour };
      },
    });
    const sourceColour = await videoTrack.getColorSpace().catch(() => ({}));
    // The source's frame lattice, where it has one: the encoder spends its
    // bitrate by it — told nothing, Chrome's assumes 30 frames a second and
    // a 60 fps copy comes out at twice its bitrate — and the copy's times sit
    // on it exactly. A variable-rate source keeps its times as they are.
    const lattice = Number(plan.frameRate) > 0 ? Number(plan.frameRate) : null;
    output.addVideoTrack(videoSource, lattice ? { frameRate: lattice } : {});
    let audioSource = null;
    if (audioTrack && plan.audio.mode === 'copy') {
      audioSource = new EncodedAudioPacketSource('aac');
      output.addAudioTrack(audioSource);
    } else if (audioTrack && plan.audio.mode === 'encode') {
      audioSource = new AudioSampleSource({
        codec: 'aac',
        quality: new Quality({ bitrate: plan.audio.bitrate }),
        transform: { numberOfChannels: plan.audio.numberOfChannels, sampleRate: plan.audio.sampleRate },
      });
      output.addAudioTrack(audioSource);
    }
    await output.start();

    const firsts = await Promise.all([videoTrack.getFirstTimestamp(), audioTrack ? audioTrack.getFirstTimestamp() : Infinity]);
    const start = Math.max(0, Math.min(...firsts));
    const duration = plan.duration || (await this.input.computeDuration([videoTrack]).catch(() => 0)) - start;
    const clock = { video: 0, videoDone: false, wake: null };
    const tick = () => { const w = clock.wake; clock.wake = null; w?.(); };

    let lastReport = 0;
    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - lastReport < PROGRESS_MS) return;
      lastReport = now;
      onProgress?.({ phase: 'convert', fraction: duration > 0 ? Math.min(1, clock.video / duration) : null, done: clock.video });
    };

    const pumpVideo = async () => {
      const decoded = new VideoSampleSink(videoTrack);
      const hdr = plan.hdr || null;
      let mapper = null;
      const scaler = frameScaler(plan.width, plan.height);
      let slice = Date.now();
      let lastSlot = -Infinity;
      // Whether a decoded frame goes in, and when it ends: frames before the
      // start are left out, and — on a lattice — one that lands on the point
      // of the one before (a file that strays from its rate), rather than be
      // written at the same time as it.
      const admit = (timestamp, length) => {
        if (timestamp + length <= start) return false;
        if (!lattice) return true;
        const slot = Math.round((timestamp - start) * lattice);
        if (slot <= lastSlot) return false;
        lastSlot = slot;
        return true;
      };
      const encode = async (frame, timestamp, length) => {
        frame.setTimestamp(timestamp - start);
        frame.setDuration(length);
        await videoSource.add(frame);
        clock.video = Math.max(clock.video, timestamp + length - start);
        tick();
        report();
        if (this.onPage && Date.now() - slice > PAGE_SLICE_MS) {
          await yieldToPage();
          slice = Date.now();
        }
      };
      // A made frame (lib/hdr-tonemap.js) into the encoder: RGBX, sRGB.
      const emitMapped = async ({ data, meta }) => {
        const frame = new VideoSample(data, {
          format: 'RGBX', codedWidth: plan.width, codedHeight: plan.height,
          timestamp: meta.timestamp, duration: meta.duration, colorSpace: TONE_MAPPED_COLOUR,
        });
        try {
          await encode(frame, meta.timestamp, meta.duration);
        } finally {
          frame.close();
        }
      };
      try {
        for await (const sample of decoded.samples(start)) {
          if (this.cancelled) { sample.close(); break; }
          const { timestamp, duration: length } = sample;
          if (!admit(timestamp, length)) { sample.close(); continue; }
          if (hdr?.via === 'shader') {
            // HDR handed over as if it were SDR (WebKit): taken to SDR from its
            // own planes, turned and scaled on the GPU, a few frames in flight.
            colour ||= CANVAS_COLOUR;
            mapper ||= toneMapper(plan.width, plan.height, { transfer: hdr.transfer, rotation: sample.rotation, flip: sample.flip });
            const raw = sample.toVideoFrame();
            try {
              await mapper.submit(raw, { timestamp, duration: length });
            } finally {
              raw.close();
              sample.close();
            }
            if (mapper.pending >= TONE_MAP_DEPTH) await emitMapped(await mapper.next());
            continue;
          }
          // Else as decoded where that is already the copy — upright, square
          // pixels, its size, SDR, 8-bit 4:2:0, labelled as its source is (the
          // encoder writes the label into the copy, and WebKit labels video
          // frames full-range sRGB: a limited-range copy marked full range
          // shows grey blacks) — or turned and scaled onto sRGB canvases
          // (frameScaler), which are colour-managed: an HDR frame the browser
          // says is HDR is tone-mapped by it as it is drawn (Chrome).
          const labelled = (sample.colorSpace?.fullRange === true) === (sourceColour?.fullRange === true)
            && sample.colorSpace?.transfer !== 'iec61966-2-1';
          const asIs = !hdr && labelled && sample.rotation === 0 && !sample.flip
            && sample.codedWidth === plan.width && sample.codedHeight === plan.height
            && sample.displayWidth === plan.width && sample.displayHeight === plan.height
            && (sample.format === 'I420' || sample.format === 'NV12');
          const frame = asIs ? sample : new VideoSample(scaler.draw(sample), { timestamp, duration: length });
          colour ||= asIs ? decodedColour(sourceColour) : CANVAS_COLOUR;
          try {
            await encode(frame, timestamp, length);
          } finally {
            if (frame !== sample) frame.close();
            sample.close();
          }
        }
        while (mapper?.pending && !this.cancelled) await emitMapped(await mapper.next());
      } finally {
        mapper?.close();
        scaler.close();
      }
      videoSource.close();
      clock.videoDone = true;
      tick();
    };

    const waitForVideo = async (t) => {
      while (!this.cancelled && !clock.videoDone && t - start > clock.video + AUDIO_LEAD_SECONDS) {
        await new Promise((resolve) => { clock.wake = resolve; });
      }
    };

    const pumpAudio = async () => {
      if (!audioTrack || !audioSource) return;
      if (plan.audio.mode === 'copy') {
        const packets = new EncodedPacketSink(audioTrack);
        const decoderConfig = await audioTrack.getDecoderConfig();
        let first = true;
        for await (const packet of packets.packets()) {
          if (this.cancelled) break;
          // The priming before zero is kept, for the edit list to skip as the
          // original's did (lib/mp4-roll.js says how every player then agrees).
          if (packet.timestamp + packet.duration <= start - PRIMING_SECONDS) continue;
          await waitForVideo(packet.timestamp);
          await audioSource.add(packet.clone({ timestamp: packet.timestamp - start }), first ? { decoderConfig } : undefined);
          first = false;
        }
      } else {
        // An AAC encoder starts with silence of its own (priming): the sound
        // is handed to it that much early, so the priming falls before zero
        // — the MP4's edit list skips it — and the sound lands with its
        // picture rather than 44 ms after.
        const delay = await aacEncoderDelay(plan.audio);
        const samples = new AudioSampleSink(audioTrack);
        for await (const sample of samples.samples(start)) {
          try {
            if (this.cancelled) break;
            if (sample.timestamp + sample.duration <= start) continue;
            await waitForVideo(sample.timestamp);
            sample.setTimestamp(sample.timestamp - start - delay);
            await audioSource.add(sample);
          } finally {
            sample.close();
          }
        }
      }
      audioSource.close();
    };

    // A copy that stops moving — an encoder or decoder that has hung, storage
    // that has gone quiet — is stopped and said so, rather than left showing
    // the same percentage for ever.
    let seen = clock.video;
    let moved = Date.now();
    const watchdog = setInterval(() => {
      if (clock.video !== seen) { seen = clock.video; moved = Date.now(); return; }
      if (Date.now() - moved > STALL_MS) {
        this.fail(new VideoConvertError('convert', 'The copy stopped: this browser’s video encoder or the storage stopped answering. Try again, or download the original.'));
      }
    }, 1000);

    // Stopped (a cancel, the watchdog) is stopped at once, even with a
    // decoder or encoder that never answers again.
    const stopped = new Promise((_, reject) => { this.stop = reject; });
    stopped.catch(() => { /* answered below, or after the copy is done */ });
    try {
      await Promise.race([Promise.all([pumpVideo(), pumpAudio()]), stopped]);
      clearInterval(watchdog);
      if (this.cancelled) throw aborted();
      report(true);
      onProgress?.({ phase: 'finish', fraction: 1, done: clock.video });
      sink.finishing?.();
      await output.finalize();
      // The moov made right for Apple's players (lib/mp4-roll.js), and the file committed.
      await sink.seal?.();
    } catch (e) {
      clearInterval(watchdog);
      if (this.failure) throw this.failure;
      if (this.cancelled) throw aborted();
      await output.cancel().catch(() => {});
      throw asConvertError(e);
    }
    if (this.failure) throw this.failure;
    if (this.cancelled) throw aborted();
    return { bytes: sink.size };
  }

  /** Stops everything under way; what was written is thrown away. */
  async cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.stop?.(aborted());
    this.controller.abort();
    await this.sink?.discard?.();
    await this.output?.cancel().catch(() => {});
    this.input?.dispose();
  }

  /** Stops everything under way because of `error`, which the copy then fails with. */
  fail(error) {
    if (this.cancelled) return;
    this.failure = error;
    this.cancel();
  }

  /** Lets go of the original. */
  dispose() {
    this.cancelled = true;
    this.controller.abort();
    this.input?.dispose();
    this.input = null;
  }
}

/** A failure from deep in the pipeline, as something a person can be told. */
function asConvertError(e) {
  if (e instanceof VideoConvertError) return e;
  if (e?.name === 'AbortError') return e;
  const cause = e?.cause;
  if (cause instanceof VideoConvertError) return cause;
  const text = `${e?.name || ''} ${e?.message || ''}`;
  if (/fetch|network|load failed|HTTP/i.test(text)) {
    return new VideoConvertError('read', 'The original stopped arriving from storage. Try again.');
  }
  return new VideoConvertError('convert', `This browser stopped while converting the video${e?.message ? ` (${String(e.message).slice(0, 160)})` : ''}. Download the original instead.`);
}

/**
 * How an HDR track's frames are taken to SDR here, from its first frame:
 * 'canvas' where the browser says the frame is HDR (Chrome) — its canvas
 * tone-maps what is drawn on it; 'shader' where it hands the frame over as
 * if it were SDR (WebKit: 8-bit NV12 labelled sRGB) and lib/hdr-tonemap.js
 * can read its planes; null where neither — no copy of it is offered.
 */
async function hdrRoute(track, transfer) {
  if (!transfer) return null;
  let sample = null;
  try {
    sample = await new VideoSampleSink(track).getSample(await track.getFirstTimestamp());
    if (!sample) return null;
    const said = sample.colorSpace?.transfer;
    if (said === 'hlg' || said === 'pq') return 'canvas';
    return toneMappable(sample.format) && canToneMap() ? 'shader' : null;
  } catch {
    return null;
  } finally {
    sample?.close();
  }
}

/** Whether this browser's H.264 encoder takes `config` (lib/video-formats.js videoEncoderConfig), as the copy asks. */
async function encodes(config, latencyMode) {
  try {
    return await canEncodeVideo('avc', {
      width: config.width,
      height: config.height,
      quality: new Quality({ bitrate: config.bitrate }),
      frameRate: config.framerate,
      fullCodecString: config.codec,
      latencyMode,
    });
  } catch {
    return false;
  }
}

/** How long a second of small frames may take to come out of an encoder that works. */
const FRAME_TEST_MS = 2500;
let h264Tested = null;

/** `promise`, or a rejection once `ms` have passed without it settling. */
const within = (promise, ms) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error('It did not finish in time.')), ms)),
]);

/**
 * The H.264 profile and latencyMode this browser's encoder actually makes
 * every frame in: { profile, latencyMode } from H264_MODES, or null when none
 * does. High in 'quality' mode — which reorders frames, for the most picture
 * per bit — where it works (Chrome). WebKit (Safari, Onyx for Mac's web
 * view) says it supports that, then takes four frames and no more — nothing
 * comes out and a flush never finishes, so a copy would hang at its fifth
 * frame — and the same of Main; its 'realtime' mode makes frames but drops
 * the one after each key frame it is asked for. Its Constrained Baseline in
 * 'quality' mode makes every frame. So each is tried once, side by side,
 * with two seconds of small frames and a key frame asked for part way: the
 * first that returns every frame is used.
 */
export function h264Mode() {
  h264Tested ||= Promise.all(H264_MODES.map((m) => makesEveryFrame(m)))
    .then((ok) => H264_MODES.find((_, i) => ok[i]) || null);
  return h264Tested;
}

async function makesEveryFrame({ profile, latencyMode }) {
  const width = 320;
  const height = 180;
  const frames = 60;
  let made = 0;
  let failed = false;
  let encoder;
  try {
    encoder = new VideoEncoder({ output: () => { made++; }, error: () => { failed = true; } });
    encoder.configure({ codec: h264CodecString(31, profile), width, height, bitrate: 1e6, framerate: 30, latencyMode, avc: { format: 'avc' } });
    const plane = new Uint8Array((width * height * 3) / 2);
    for (let i = 0; i < frames; i++) {
      plane.fill(40 + ((i * 37) % 180), 0, width * height);
      const frame = new VideoFrame(plane, { format: 'I420', codedWidth: width, codedHeight: height, timestamp: Math.round((i * 1e6) / 30), duration: Math.round(1e6 / 30) });
      encoder.encode(frame, { keyFrame: i % 30 === 0 });
      frame.close();
    }
    const flushed = await Promise.race([
      encoder.flush().then(() => true, () => false),
      new Promise((resolve) => setTimeout(() => resolve(false), FRAME_TEST_MS)),
    ]);
    return flushed && made === frames && !failed;
  } catch {
    return false;
  } finally {
    try { encoder?.close(); } catch { /* closed already */ }
  }
}

/** The delay AAC-LC encoders commonly start with (Apple's AudioToolbox, Fraunhofer's FDK), in samples. */
const AAC_PRIMING_SAMPLES = 2112;
const delays = new Map();

/**
 * How far this browser's AAC encoder delays what it is given, in seconds —
 * WebCodecs does not say, so it is measured, once per configuration: a burst
 * encoded, decoded, and found again. AAC_PRIMING_SAMPLES where it cannot be.
 */
export function aacEncoderDelay({ sampleRate, numberOfChannels, bitrate }) {
  const key = `${sampleRate}/${numberOfChannels}/${bitrate}`;
  if (!delays.has(key)) {
    delays.set(key, measureAacDelay({ sampleRate, numberOfChannels, bitrate }).catch(() => AAC_PRIMING_SAMPLES / sampleRate));
  }
  return delays.get(key);
}

async function measureAacDelay({ sampleRate, numberOfChannels, bitrate }) {
  const frames = 8192;
  const at = 3072;
  let failure = null;
  let decoderConfig = null;
  const chunks = [];
  const encoder = new AudioEncoder({
    output: (chunk, meta) => { chunks.push(chunk); if (meta?.decoderConfig) decoderConfig = meta.decoderConfig; },
    error: (e) => { failure = e; },
  });
  encoder.configure({ codec: 'mp4a.40.2', sampleRate, numberOfChannels, bitrate });
  // Silence, then a tone that starts at full swing: its first loud sample is `at`.
  const data = new Float32Array(frames * numberOfChannels);
  for (let c = 0; c < numberOfChannels; c++) {
    for (let i = 0; i < 1024; i++) data[c * frames + at + i] = 0.8 * Math.cos((2 * Math.PI * 1000 * i) / sampleRate);
  }
  const audio = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: frames, numberOfChannels, timestamp: 0, data });
  encoder.encode(audio);
  audio.close();
  // An encoder that never finishes is not waited on: the usual delay is assumed.
  await within(encoder.flush(), FRAME_TEST_MS);
  encoder.close();
  if (failure || !decoderConfig || !chunks.length) throw failure || new Error('The encoder made nothing.');
  const decoded = [];
  const decoder = new AudioDecoder({
    output: (d) => {
      const buf = new Float32Array(d.numberOfFrames);
      d.copyTo(buf, { planeIndex: 0, format: 'f32-planar' });
      decoded.push(buf);
      d.close();
    },
    error: (e) => { failure = e; },
  });
  decoder.configure(decoderConfig);
  for (const c of chunks) decoder.decode(c);
  await within(decoder.flush(), FRAME_TEST_MS);
  decoder.close();
  if (failure) throw failure;
  let pos = 0;
  for (const buf of decoded) {
    for (let i = 0; i < buf.length; i++) {
      if (Math.abs(buf[i]) > 0.4) {
        const delay = pos + i - at;
        if (delay < 0 || delay > 4 * 1024) throw new Error('Not a delay an AAC encoder has.');
        return delay / sampleRate;
      }
    }
    pos += buf.length;
  }
  throw new Error('The burst was not found.');
}

async function describeAudio(track) {
  const [codec, codecString, channels, sampleRate, decode, stats] = await Promise.all([
    track.getCodec(), track.getCodecParameterString(), track.getNumberOfChannels(), track.getSampleRate(),
    track.canDecode(), track.computePacketStats(200).catch(() => null),
  ]);
  return {
    // xHE-AAC (USAC) is AAC by name only: not every player decodes it, so it is remade.
    codec: codec === 'aac' && /^mp4a\.40\.42$/i.test(codecString || '') ? 'usac' : codec,
    codecString, channels, sampleRate, decode: decode === true,
    bitrate: stats?.averageBitrate > 0 ? Math.round(stats.averageBitrate) : null,
  };
}
