// lib/video-formats.js — what a video may be downloaded as besides its
// original: an MP4 of H.264 and AAC at 4K, 1080p or 720p, made in the
// browser from the original (lib/video-convert.js), or — for the size its
// proxy is — the proxy the Mac already made (lib/proxies.js).
//
// Pure, and shared: the Download-as dialog decides from it what to offer,
// how big each copy comes out and how long it takes; the converter takes its
// sizes, codec strings and bitrates from it; so an offer and the file that
// arrives cannot disagree.
//
// The rules:
//
//   sizes    "p" is the short edge, as it is shown (rotation applied): a
//            1080 × 1920 phone clip is 1080p. Only sizes at or below the
//            source's short edge — never upscaled — so 4K (2160p) only from a
//            source at least 2160 on its short side.
//   codecs   H.264 High in an MP4, AAC-LC sound: every copy plays in
//            QuickTime, Safari and Chrome. The level is worked out from the
//            frame's size and rate (H.264 table A-1); nothing past 5.2,
//            which is as far as those players go.
//   bitrate  YouTube's recommended upload rates for SDR H.264 — 4K 40 Mb/s,
//            1080p 8, 720p 5 at up to 30 frames a second; 60, 12 and 7.5
//            above — and never more than the source itself spends (in
//            H.264's terms), so a copy is not bigger than its original for
//            nothing.
//   sound    AAC stereo or mono is copied as it is. Anything else — Opus,
//            PCM, MP3, 5.1 — is made AAC (stereo at most) where this
//            browser's AudioEncoder can; where it cannot, no copy is offered
//            (5.1 AAC is then copied as it is: still AAC).
//   memory   A copy is held in memory until it is saved, then handed over as
//            one Blob — about twice its size at that moment. Up to
//            MEMORY_MAX_BYTES; past it, only where the File System Access API
//            can write it straight to disk (Chrome, Edge), else refused.

import { proxySpec, PROXY_MAX_HEIGHT } from './proxies.js';
import { fmtSize } from './media.js';

/** The copies offered, largest first. `short` is the short edge in pixels; `name` what the copy is called. */
export const VIDEO_TARGETS = Object.freeze([
  Object.freeze({ id: '2160p', short: 2160, name: '4K' }),
  Object.freeze({ id: '1080p', short: 1080, name: '1080p' }),
  Object.freeze({ id: '720p', short: 720, name: '720p' }),
]);

/**
 * The most a copy made in memory may come to. It is held in the tab until it
 * is done and then handed to the browser as one file — about twice its size
 * at that moment, then once more as the browser saves it. A gibibyte keeps
 * that well inside what a desktop browser tab holds (and what Onyx for Mac's
 * web view hands to its downloads), and covers about 17 minutes at 1080p,
 * 11 at 1080p60, or 3 of 4K. A ten-minute 4K clip is about 3 GB: that is
 * written straight to disk where the browser can (Chrome, Edge), and refused
 * elsewhere.
 */
export const MEMORY_MAX_BYTES = 1024 ** 3;
/** An estimate is planned in memory only with this much headroom: a variable-bitrate encoder can overshoot. */
export const ESTIMATE_MARGIN = 1.25;
/**
 * Storage that ignores range requests can only be read from the start: the
 * whole original is then fetched first (into the browser's own Blob storage,
 * not the page's memory), up to this.
 */
export const WHOLE_READ_MAX_BYTES = 1024 ** 3;
/** Past this estimate the dialog says the job is long and to keep the page open. */
export const LONG_JOB_SECONDS = 5 * 60;
/** A key frame every two seconds, as the proxy has: a seek lands near where it was asked for. */
export const KEYFRAME_SECONDS = 2;

/** Bits a second, by short edge: YouTube's upload guidance for SDR H.264, at up to 30 frames a second and above. */
export const VIDEO_BITRATES = Object.freeze({
  2160: Object.freeze({ standard: 40e6, high: 60e6 }),
  1080: Object.freeze({ standard: 8e6, high: 12e6 }),
  720: Object.freeze({ standard: 5e6, high: 7.5e6 }),
});
/** Above this many frames a second, the high-frame-rate row (48, 50, 60…). */
export const HIGH_FRAME_RATE = 30.5;
/**
 * How many times more bits H.264 needs than the source's codec for the same
 * picture — the source's own bitrate, times this, is the most a copy is
 * given. A codec not named is taken as H.264's equal.
 */
export const CODEC_EFFICIENCY = Object.freeze({ hevc: 1.5, vp9: 1.5, av1: 1.5 });
/** Nor less than this share of the target's rate: re-encoding a starved source at its own rate compounds the damage. */
export const MIN_BITRATE_SHARE = 0.25;
/** AAC-LC: 128 kb/s mono, 192 kb/s stereo. */
export const AUDIO_BITRATES = Object.freeze({ mono: 128000, stereo: 192000 });
/** The sample rates the AAC encoders take; anything else is resampled to 48 kHz. */
export const AAC_SAMPLE_RATES = Object.freeze([44100, 48000]);
/** What a copied track is assumed to spend when the file does not say. */
const AUDIO_COPY_ESTIMATE = 192000;
/** The MP4's own boxes and indexes, on top of the media. */
const CONTAINER_OVERHEAD = 1.01;

/**
 * How fast a machine turns video over, in pixels a second, for the time
 * estimate: decoding the source (and drawing it at the copy's size), and
 * encoding the copy. Fitted a little under what Safari's engine took on an
 * M5 Max — the slower of the two engines there; Chrome on the same machine
 * was three to seven times faster (the measurements are in
 * test/video-formats.test.js) — so an older machine is not promised much
 * less time than it takes. Once a copy is being made, the time left shown is
 * measured from its progress (etaSeconds), not estimated.
 */
export const DECODE_PIXELS_PER_SECOND = 600e6;
export const ENCODE_PIXELS_PER_SECOND = 400e6;
/** Opening the original, and the encoder's start and finish, whatever the length. */
const FIXED_SECONDS = 2;

/**
 * H.264 levels (ITU-T H.264 table A-1): the most macroblocks a second and in
 * a frame, and the most kilobits a second for Baseline and Main — High may
 * use a quarter more. Up to 5.2: Safari and QuickTime go no further.
 */
export const H264_LEVELS = Object.freeze([
  Object.freeze({ level: 30, mbps: 40500, fs: 1620, kbps: 10000 }),
  Object.freeze({ level: 31, mbps: 108000, fs: 3600, kbps: 14000 }),
  Object.freeze({ level: 32, mbps: 216000, fs: 5120, kbps: 20000 }),
  Object.freeze({ level: 40, mbps: 245760, fs: 8192, kbps: 20000 }),
  Object.freeze({ level: 41, mbps: 245760, fs: 8192, kbps: 50000 }),
  Object.freeze({ level: 42, mbps: 522240, fs: 8704, kbps: 50000 }),
  Object.freeze({ level: 50, mbps: 589824, fs: 22080, kbps: 135000 }),
  Object.freeze({ level: 51, mbps: 983040, fs: 36864, kbps: 240000 }),
  Object.freeze({ level: 52, mbps: 2073600, fs: 36864, kbps: 240000 }),
]);
/** Of a level's bitrate ceiling, the share each profile may use (H.264 table A-1's cpbBrVclFactor). */
const PROFILE_BITRATE_FACTOR = Object.freeze({ high: 1.25, baseline: 1 });
/** A variable-bitrate encoder's peaks, over its target: what a level's ceiling must allow. */
const PEAK_OVER_TARGET = 1.5;

/**
 * The H.264 profiles and latency modes a copy may be encoded in, in the
 * order they are wanted — lib/video-convert.js h264Mode tries each and uses
 * the first this browser's encoder makes every frame in:
 *
 *   High, 'quality'       the best picture per bit (B-frames, CABAC): Chrome
 *   Constrained Baseline, 'quality'
 *                         WebKit, whose High and Main stall in 'quality' mode
 *                         and drop frames in 'realtime'; no B-frames or CABAC,
 *                         so a little less picture for the same bits — and
 *                         nothing plays more widely
 *   High, 'realtime'      a last resort: no frame reordering
 */
export const H264_MODES = Object.freeze([
  Object.freeze({ profile: 'high', latencyMode: 'quality' }),
  Object.freeze({ profile: 'baseline', latencyMode: 'quality' }),
  Object.freeze({ profile: 'high', latencyMode: 'realtime' }),
]);

const byId = new Map(VIDEO_TARGETS.map((t) => [t.id, t]));

/** A VIDEO_TARGETS entry by id ('2160p', '1080p', '720p'), or null. */
export function videoTarget(id) {
  return byId.get(id) || null;
}

function dims(input) {
  const width = Number(input?.width);
  const height = Number(input?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width: Math.round(width), height: Math.round(height) };
}

const even = (v) => Math.max(2, Math.round(v / 2) * 2);

/** The short edge of a { width, height } as shown, or null. */
export function shortEdge(size) {
  const s = dims(size);
  return s ? Math.min(s.width, s.height) : null;
}

/**
 * The size of a copy whose short edge is `short`, from a source of `size` (as
 * shown): the aspect kept, both sides even as H.264's 4:2:0 needs, never
 * larger than the source. Null without usable dimensions.
 */
export function videoTargetSize(size, short) {
  const s = dims(size);
  const edge = Number(short);
  if (!s || !Number.isFinite(edge) || edge <= 0) return null;
  const scale = Math.min(1, edge / Math.min(s.width, s.height));
  return { width: even(s.width * scale), height: even(s.height * scale) };
}

/**
 * The copies a source of `size` (as shown) is offered: each target at or
 * below its short edge, with the size it comes out at. With no size on
 * record, every target, sizes unknown — the probe of the file itself
 * decides.
 */
export function videoTargets(size) {
  const edge = shortEdge(size);
  if (edge == null) return VIDEO_TARGETS.map((t) => ({ ...t, width: null, height: null }));
  return VIDEO_TARGETS.filter((t) => t.short <= edge).map((t) => ({ ...t, ...videoTargetSize(size, t.short) }));
}

/**
 * The lowest H.264 level (as 31 for 3.1) that holds a picture of `width` ×
 * `height` at `fps` frames a second and `bitrate` bits a second, in `profile`
 * ('high' or 'baseline'); null past 5.2 or without a usable size.
 */
export function h264Level({ width, height, fps = 30, bitrate = 0, profile = 'high' } = {}) {
  const s = dims({ width, height });
  if (!s) return null;
  const rate = Number(fps) > 0 ? Number(fps) : 30;
  const mbw = Math.ceil(s.width / 16);
  const mbh = Math.ceil(s.height / 16);
  const fs = mbw * mbh;
  const mbps = fs * rate;
  const peak = (Number(bitrate) || 0) * PEAK_OVER_TARGET;
  const factor = PROFILE_BITRATE_FACTOR[profile] || 1;
  for (const l of H264_LEVELS) {
    // Neither side longer than √(8 × MaxFS) macroblocks (A.3.1 f and g).
    const side = Math.sqrt(8 * l.fs);
    if (fs <= l.fs && mbps <= l.mbps && mbw <= side && mbh <= side && peak <= l.kbps * 1000 * factor) return l.level;
  }
  return null;
}

/**
 * The codec string for `level` in `profile`: High as 'avc1.6400' + the
 * level in hex (31 → 'avc1.64001F'); Constrained Baseline as 'avc1.42E0' +
 * the level ('avc1.42E01F').
 */
export function h264CodecString(level, profile = 'high') {
  const l = Number(level);
  if (!Number.isInteger(l) || l <= 0 || l > 255) return null;
  const hex = l.toString(16).toUpperCase().padStart(2, '0');
  return profile === 'baseline' ? `avc1.42E0${hex}` : `avc1.6400${hex}`;
}

/**
 * Bits a second for a copy with a `short` edge at `fps`: VIDEO_BITRATES, the
 * high-frame-rate row above HIGH_FRAME_RATE and in proportion past 60; never
 * more than the source spends (`sourceBitrate`, its video's, in
 * `sourceCodec` — times CODEC_EFFICIENCY), nor less than MIN_BITRATE_SHARE
 * of the row.
 */
export function videoBitrate({ short, fps = 30, sourceBitrate = null, sourceCodec = null } = {}) {
  const row = VIDEO_BITRATES[short];
  if (!row) return null;
  const rate = Number(fps) > 0 ? Number(fps) : 30;
  const base = rate > HIGH_FRAME_RATE ? row.high * Math.max(1, rate / 60) : row.standard;
  const src = Number(sourceBitrate);
  if (!Number.isFinite(src) || src <= 0) return Math.round(base);
  const cap = src * (CODEC_EFFICIENCY[sourceCodec] || 1);
  return Math.round(Math.min(base, Math.max(cap, base * MIN_BITRATE_SHARE)) / 1000) * 1000;
}

/**
 * What the encoder is configured with for target `id` from a source `video`
 * ({ width, height } as shown, fps, bitrate, codec), in `profile`: the codec
 * string, size, bitrate and rate — the same for the probe that asks the
 * browser whether it can, and the conversion that then does. Null when the
 * target is not offered for this source (upscaled, or past level 5.2).
 */
export function videoEncoderConfig(video, id, { profile = 'high' } = {}) {
  const target = videoTarget(id);
  const edge = shortEdge(video);
  if (!target || edge == null || target.short > edge) return null;
  const size = videoTargetSize(video, target.short);
  const fps = Number(video.fps) > 0 ? Number(video.fps) : 30;
  const bitrate = videoBitrate({ short: target.short, fps, sourceBitrate: video.bitrate, sourceCodec: video.codec });
  const level = h264Level({ ...size, fps, bitrate, profile: profile || 'high' });
  if (!level) return null;
  return { codec: h264CodecString(level, profile || 'high'), width: size.width, height: size.height, bitrate, framerate: fps };
}

/**
 * The AAC a source's `audio` ({ codec, channels, sampleRate }) would be
 * encoded to, when it must be: stereo at most, at 44.1 or 48 kHz. Null for
 * no audio.
 */
export function audioEncodeConfig(audio) {
  const channels = Number(audio?.channels);
  if (!audio || !Number.isFinite(channels) || channels <= 0) return null;
  const out = Math.min(2, channels);
  const rate = Number(audio.sampleRate);
  return {
    codec: 'mp4a.40.2',
    numberOfChannels: out,
    sampleRate: AAC_SAMPLE_RATES.includes(rate) ? rate : 48000,
    bitrate: out === 1 ? AUDIO_BITRATES.mono : AUDIO_BITRATES.stereo,
  };
}

/**
 * What happens to a source's sound: { mode: 'none' } for none; 'copy' for
 * AAC in one or two channels (or more, where it cannot be remade); 'encode',
 * with the config, for anything the browser decodes and can make AAC of.
 * Null when it cannot be made AAC here — no copy is then offered.
 * `aacEncode`: whether this browser's AudioEncoder takes audioEncodeConfig's.
 */
export function audioPlan(audio, { aacEncode = false } = {}) {
  if (!audio) return { mode: 'none', bitrate: 0 };
  const aac = audio.codec === 'aac';
  if (aac && Number(audio.channels) <= 2) {
    return { mode: 'copy', bitrate: Number(audio.bitrate) > 0 ? Number(audio.bitrate) : AUDIO_COPY_ESTIMATE };
  }
  const config = audioEncodeConfig(audio);
  if (config && audio.decode !== false && aacEncode) return { mode: 'encode', ...config };
  // 5.1 AAC that cannot be made stereo here stays as it is: still AAC.
  if (aac) return { mode: 'copy', bitrate: Number(audio.bitrate) > 0 ? Number(audio.bitrate) : AUDIO_COPY_ESTIMATE };
  return null;
}

/** Bytes a copy of `duration` seconds comes to at these rates, the container's boxes included; null without a duration. */
export function estimateBytes({ duration, videoBitrate: v = 0, audioBitrate: a = 0 } = {}) {
  const d = Number(duration);
  if (!Number.isFinite(d) || d <= 0) return null;
  return Math.round((d * ((Number(v) || 0) + (Number(a) || 0))) / 8 * CONTAINER_OVERHEAD);
}

/**
 * Seconds a conversion takes on a typical machine: every frame decoded at
 * the source's size and encoded at the copy's, at DECODE_ and
 * ENCODE_PIXELS_PER_SECOND. The original's download is not in it — how fast
 * the storage is, nothing here knows; the progress's ETA includes it.
 */
export function estimateSeconds({ duration, fps = 30, source, target } = {}) {
  const d = Number(duration);
  const s = dims(source);
  const t = dims(target);
  if (!Number.isFinite(d) || d <= 0 || !s || !t) return null;
  const frames = d * (Number(fps) > 0 ? Number(fps) : 30);
  return Math.round(FIXED_SECONDS + frames * ((s.width * s.height) / DECODE_PIXELS_PER_SECOND + (t.width * t.height) / ENCODE_PIXELS_PER_SECOND));
}

/**
 * Where a copy of an estimated `bytes` is made: 'memory' when it fits under
 * MEMORY_MAX_BYTES with ESTIMATE_MARGIN to spare (or its size is unknown —
 * the cap is then enforced as it is made), else 'disk' where the browser can
 * write a file as it goes (`disk`), else null: refused.
 */
export function outputPlace(bytes, { disk = false } = {}) {
  const b = Number(bytes);
  if (bytes == null || !Number.isFinite(b) || b * ESTIMATE_MARGIN <= MEMORY_MAX_BYTES) return 'memory';
  return disk ? 'disk' : null;
}

/**
 * How the original is read: 'range' — in pieces as they are needed, the
 * browser holding a few megabytes at a time — where the storage answers
 * range requests across origins; else 'whole', fetched first, up to
 * WHOLE_READ_MAX_BYTES; else null.
 */
export function sourceRead({ range = false, bytes = null } = {}) {
  if (range) return 'range';
  const b = Number(bytes);
  return Number.isFinite(b) && b > 0 && b <= WHOLE_READ_MAX_BYTES ? 'whole' : null;
}

/**
 * The plan for making target `id` from a `probe` of the original (lib/
 * video-convert.js probeVideo): everything the converter needs, and what the
 * dialog shows — or { id, reason } when it cannot be made here:
 *
 *   'upscale'  the source is smaller than this
 *   'level'    past H.264 level 5.2
 *   'decode'   this browser cannot decode the source's video
 *   'hdr'      nor take its HDR to SDR faithfully
 *   'encode'   nor encode H.264 at this size
 *   'audio'    nor make AAC of its sound
 *   'size'     too large to hold in memory, and no way to write it to disk
 *
 * `disk`: whether this browser can write a file as it goes.
 */
export function videoPlan(probe, id, { disk = false } = {}) {
  const video = probe?.video;
  const target = videoTarget(id);
  if (!target || !video) return { id, reason: 'probe' };
  // The profile and mode the probe saw this browser's encoder make every frame in.
  const h264 = probe.h264 || H264_MODES[0];
  const config = videoEncoderConfig(video, id, { profile: h264.profile });
  if (!config) return { id, reason: shortEdge(video) != null && target.short > shortEdge(video) ? 'upscale' : 'level' };
  if (!video.decode) return { id, reason: 'decode' };
  // HDR only where it can be taken to SDR faithfully here (lib/video-convert.js hdrRoute).
  if (video.hdr === true && video.hdrPath !== 'canvas' && video.hdrPath !== 'shader') return { id, reason: 'hdr' };
  if (probe.encode?.[id] !== config.codec) return { id, reason: 'encode' };
  const audio = audioPlan(probe.audio, { aacEncode: probe.aac === true });
  if (!audio) return { id, reason: 'audio' };
  const bytes = estimateBytes({ duration: video.duration, videoBitrate: config.bitrate, audioBitrate: audio.bitrate });
  const place = outputPlace(bytes, { disk });
  if (!place) return { id, reason: 'size', bytes };
  return {
    id,
    name: target.name,
    ...config,
    keyFrameSeconds: KEYFRAME_SECONDS,
    // In the profile and mode the probe saw this browser's encoder make
    // every frame in (H264_MODES; lib/video-convert.js h264Mode).
    profile: h264.profile,
    latencyMode: h264.latencyMode,
    // The frame lattice the source sits on, if it has one: kept.
    frameRate: Number(video.frameRate) > 0 ? Number(video.frameRate) : null,
    audio,
    // HDR is taken to SDR on the way: by the browser's colour-managed canvas,
    // or from the frames' planes (lib/video-convert.js, lib/hdr-tonemap.js).
    hdr: video.hdr === true ? { transfer: video.transfer || null, via: video.hdrPath } : null,
    duration: Number(video.duration) || null,
    bytes,
    seconds: estimateSeconds({ duration: video.duration, fps: config.framerate, source: video, target: config }),
    place,
  };
}

/**
 * The proxy's short edge: proxySpec's height, from the source's short edge —
 * Onyx for Mac makes it 1080 on its short side, never larger than the
 * source (apple/OnyxKit ProxyTranscoder.outputSize). From the height alone
 * when that is all on record; 1080 when nothing is.
 */
export function proxyShortEdge(file) {
  const md = file?.metadata || {};
  const edge = shortEdge({ width: md.width, height: md.height });
  const h = Number(md.height);
  const from = edge ?? (Number.isFinite(h) && h > 0 ? h : PROXY_MAX_HEIGHT);
  return proxySpec({ height: from }).height;
}

/** Whether a video's size on record (or none) leaves any target to offer. */
export function hasVideoTargets(file) {
  const md = file?.metadata || {};
  return videoTargets({ width: md.width, height: md.height }).length > 0;
}

/**
 * A video's copies, for the dialog: one row per target this source is
 * offered, each { id, label, width, height, via, state, reason, bytes,
 * seconds, plan }:
 *
 *   via    'proxy'    the Mac's proxy is this size: downloaded as it is
 *          'convert'  made here from the original
 *   state  'ready'    can be downloaded now
 *          'checking' the original is being looked at (the probe)
 *          'off'      shown, but cannot be made here (`reason`: 'size')
 *
 * Rows this browser cannot make at all are left out; `reason` on the result
 * says why when none can be made, for the dialog to explain. `env`:
 *
 *   probe    the probe's result; null while it runs; { ok: false, reason }
 *            when it failed
 *   proxy    { available, size } — a finished proxy of this file
 *   disk     whether this browser can write a copy to disk as it goes
 *   convert  false when this browser has no WebCodecs at all
 */
export function videoChoices(file, { probe = null, proxy = null, disk = false, convert = true } = {}) {
  const md = file?.metadata || {};
  const known = probe?.ok ? probe.video : { width: md.width, height: md.height };
  const proxyEdge = proxy?.available ? proxyShortEdge(file) : null;
  const rows = [];
  let reason = null;
  let proxyUsed = false;
  for (const t of videoTargets(known)) {
    const label = `${t.name} MP4 (H.264)`;
    const size = t.width ? { width: t.width, height: t.height } : { width: null, height: null };
    if (proxyEdge === t.short) {
      proxyUsed = true;
      rows.push({ id: t.id, label, ...size, via: 'proxy', state: 'ready', reason: null, bytes: Number(proxy.size) || null, seconds: 0, plan: null });
      continue;
    }
    if (!convert) { reason ||= 'webcodecs'; continue; }
    if (!file?.url) { reason ||= 'source'; continue; }
    if (!probe) {
      rows.push({ id: t.id, label, ...size, via: 'convert', state: 'checking', reason: null, bytes: null, seconds: null, plan: null });
      continue;
    }
    if (!probe.ok) { reason ||= probe.reason || 'probe'; continue; }
    const plan = videoPlan(probe, t.id, { disk });
    if (plan.reason === 'size') {
      rows.push({ id: t.id, label, ...size, via: 'convert', state: 'off', reason: 'size', bytes: plan.bytes, seconds: null, plan: null });
      continue;
    }
    if (plan.reason) { reason ||= plan.reason; continue; }
    rows.push({ id: t.id, label, width: plan.width, height: plan.height, via: 'convert', state: 'ready', reason: null, bytes: plan.bytes, seconds: plan.seconds, plan });
  }
  return { rows, reason: rows.some((r) => r.via === 'convert' && r.state !== 'off') ? null : reason, proxyUsed };
}

/** How far back the ETA looks: long enough to smooth a slow stretch, short enough to follow a change of pace. */
export const ETA_WINDOW_MS = 15000;

/**
 * Seconds left, from `samples` of the progress so far — [{ at: ms, fraction }]
 * in order — at the pace of the last ETA_WINDOW_MS (the original's download
 * included). Null until there is a pace to go by: two seconds and 2% in.
 */
export function etaSeconds(samples) {
  const list = Array.isArray(samples) ? samples.filter((s) => Number.isFinite(s?.at) && Number.isFinite(s?.fraction)) : [];
  if (list.length < 2) return null;
  const last = list[list.length - 1];
  const first = list.find((s) => last.at - s.at <= ETA_WINDOW_MS) || list[0];
  const span = last.at - first.at;
  const done = last.fraction - first.fraction;
  if (span < 2000 || last.fraction < 0.02 || done <= 0) return null;
  return Math.max(0, Math.round(((1 - last.fraction) * span) / done / 1000));
}

/** 95 → "2 min", 30 → "under a minute", 4000 → "1 hr 7 min". */
export function fmtMinutes(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 60) return 'under a minute';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}`;
}

/** What a row's detail line says: its size, then how big and how long. */
export function videoRowDetail(row) {
  const parts = [];
  if (row.width && row.height) parts.push(`${row.width} × ${row.height}`);
  if (row.state === 'checking') parts.push('Checking…');
  else if (row.via === 'proxy') parts.push(row.bytes ? fmtSize(row.bytes) : 'Ready now');
  else if (row.state === 'off' && row.reason === 'size') parts.push(`about ${fmtSize(row.bytes)} — too large for this browser`);
  else {
    if (row.bytes) parts.push(`about ${fmtSize(row.bytes)}`);
    if (row.seconds != null) parts.push(fmtMinutes(row.seconds));
  }
  return parts.join(' · ');
}

/** What a video codec is called, by the probe's name for it (mediabunny's). */
const CODEC_NAMES = Object.freeze({ avc: 'H.264', hevc: 'HEVC', vp8: 'VP8', vp9: 'VP9', av1: 'AV1', prores: 'ProRes' });

/**
 * Why no copy can be made here, as a sentence, for a reason videoChoices or
 * the probe gave. `codec`: the probe's name for the video's codec, where it
 * knows it — else the file's extension says what it is.
 */
export function videoReasonText(reason, file, codec = null) {
  const format = String(file?.name || '').match(/\.([a-z0-9]+)$/i)?.[1]?.toUpperCase() || 'this';
  switch (reason) {
    case 'webcodecs': return 'This browser can’t convert video. Chrome, Edge and Safari can.';
    case 'decode': return `This browser can’t decode ${CODEC_NAMES[codec] || format} video, so it can’t make copies of it.`;
    case 'encode': return 'This browser can’t encode H.264 video at these sizes.';
    case 'audio': return 'This browser can’t turn this video’s sound into AAC, so it can’t make copies that play everywhere.';
    case 'level': return 'This video is too large to make an H.264 copy that plays everywhere.';
    case 'hdr': return 'This browser can’t turn this HDR video into standard range faithfully, so it doesn’t make copies of it. Chrome, Edge and Safari can.';
    case 'read': return 'The original couldn’t be read from storage to make a copy. Try again later.';
    case 'range': return 'The storage this file is in can’t be read in pieces, and the file is too large to read whole here.';
    case 'format': return 'This browser can’t read this video’s file format to make a copy.';
    case 'source': return 'There is no copy of the original here to convert.';
    default: return 'Copies of this video can’t be made in this browser.';
  }
}
