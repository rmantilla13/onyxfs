// lib/proxies.js — streamable renditions of heavy masters.
//
// A 4K ProRes master streams badly from object storage: every seek is a range
// request into gigabytes, and every byte is egress. A proxy is a small H.264
// copy that plays and seeks everywhere, including iOS Safari, at roughly 5–10%
// of the size. The player prefers it and falls back to the master.
//
// Transcoding does NOT happen on the server. A Vercel function has a 250MB
// bundle and a 300s ceiling; a 40GB master will not transcode in either. Onyx
// for Mac does it (apple/OnyxMac/Proxies/ProxyService.swift): it downloads the
// master and re-encodes it on the Mac's media engine with AVFoundation
// (OnyxKit ProxyTranscoder, to proxySpec below; ffmpegArgs is the same rendition
// for an ffmpeg worker). It claims work through the same queue idiom as
// transcripts: a side table
// keyed by file_id, an atomic claim, and a lease that expires so a worker dying
// mid-job does not wedge the row.
//
// These job primitives are shared with the transcript queue rather than
// duplicated: a device label, a progress value and a failure message mean the
// same thing in both, and two copies would drift.
import { normalizeDevice, progressValue, failureMessage as jobFailureMessage, MAX_DEVICE_CHARS, MAX_ERROR_CHARS } from './transcripts.js';
import { isProxyKey, proxyKeyFor, effectiveKind } from './media.js';

export { normalizeDevice, progressValue, MAX_DEVICE_CHARS, MAX_ERROR_CHARS };

/**
 * Why a transcode failed, cut to the same 500 characters — with this queue's own
 * fallback for a worker that said nothing. Shared code, separate wording: the
 * same message for both would tell someone watching a video that
 * "Transcription failed."
 */
export const failureMessage = (input) => jobFailureMessage(input, 'Making a streamable version failed.');
// The key's shape lives with the rest of the preview-key family, in lib/media.js.
export { isProxyKey, proxyKeyFor };

export const PROXY_STATUSES = ['queued', 'working', 'done', 'failed'];

/**
 * How long a claim holds before another Mac may take it.
 *
 * Ten minutes, the same as a transcript, and for the same reason: it is renewed
 * by every progress report, so it only runs out when a worker has actually
 * stopped. A long transcode is not a reason to make this longer — it is a
 * reason to report progress.
 */
export const LEASE_SECONDS = 600;
export const QUEUE_LIMIT = 10;

/**
 * Only video, and only when the master is big enough to be worth it — or is
 * one no browser can be relied on to play (playsInEveryBrowser). Under this,
 * a master every browser plays streams well enough, and a proxy of it costs
 * storage for nothing.
 */
export const PROXY_MIN_BYTES = 200 * 1024 * 1024;

/**
 * S3's ceiling for a single-PUT object, which is how a rendition is uploaded
 * (lib/storage.js s3PresignProxyPut). About an hour and fifty minutes at the
 * 6 Mbps ceiling; past it the worker reports a failure rather than writing a
 * truncated mp4 that would play and then stop halfway.
 */
export const PROXY_MAX_PUT_BYTES = 5 * 1024 * 1024 * 1024;

export const isProxyableKind = (kind) => kind === 'video';

/**
 * The codecs every browser plays: H.264, as avc1 or as avc3 (the same, with
 * its parameter sets in the stream). Sample entry types, as lib/mp4-probe.js
 * reads them.
 */
export const EVERY_BROWSER_CODECS = Object.freeze(['avc1', 'avc3']);

/**
 * Whether every browser plays a video as it is encoded, from what a probe
 * read of it (`metadata.videoCodec`, lib/media.js codecFacts): true, false,
 * or null when nothing was read — a file from before the codec was kept, or
 * one no probe could read.
 *
 * Only 8-bit 4:2:0 H.264 that is not HDR. ProRes, DNxHR and the rest play in
 * Safari at most. Anything 10-bit, 4:2:2 or HDR is false too, H.264
 * included: browsers decode H.264 up to the High profile, which is 8-bit
 * 4:2:0, and an HDR picture shown as SDR is washed out where it plays at all.
 *
 * HEVC is false at any bit depth, 8-bit SDR included. Safari plays it; Chrome
 * and Edge only where the machine has a decoder for it; Firefox and Linux
 * often not at all. The page cannot know beforehand which of those it is in —
 * a share link's visitor could be in any — and a master that will not decode
 * fails rather than falling back. A proxy is the copy that plays in all of
 * them, and the player prefers it where the master would have played too.
 * The cost is a Mac's transcode and a copy capped at PROXY_MAXRATE_KBPS,
 * which a phone's or a camera's HEVC runs well above — and, of an HDR
 * master, a copy in SDR: the Mac tone-maps it (OnyxKit ProxyTranscoder),
 * since eight bits labelled HLG or PQ band, and look washed out wherever the
 * label is not read. Safari, which played the HDR, shows the copy too; the
 * iPhone app plays such a master as it is (OnyxIOS MediaPage).
 */
export function playsInEveryBrowser(videoCodec) {
  const fourcc = videoCodec && typeof videoCodec === 'object' ? videoCodec.fourcc : null;
  if (typeof fourcc !== 'string' || !fourcc) return null;
  if (!EVERY_BROWSER_CODECS.includes(fourcc)) return false;
  if (Number(videoCodec.bitDepth) > 8) return false;
  if (videoCodec.chroma != null && videoCodec.chroma !== '4:2:0') return false;
  if (videoCodec.hdr === true) return false;
  return true;
}

/**
 * effectiveKind, not `file.kind`: a .mov uploaded before the kind was worked out
 * is stored as 'other', and that row is exactly the one that most needs a proxy.
 *
 * S3 only, because a proxy is an object in the bucket and there is nowhere to
 * put one otherwise.
 *
 * Big enough to be worth one, or encoded so that some browser will not play
 * it at all (playsInEveryBrowser): a 150 MB ProRes clip streams well enough,
 * and plays nowhere but Safari. A file whose codec is unknown has only its
 * size to go on, as every file did before the codec was kept.
 */
export function shouldProxy(file) {
  if (!isProxyableKind(effectiveKind(file)) || file?.storage !== 's3') return false;
  return Number(file?.size) >= PROXY_MIN_BYTES || playsInEveryBrowser(file?.metadata?.videoCodec) === false;
}

/**
 * Whether a proxy is asked for as `file` is recorded (POST /api/files): one
 * shouldProxy wants for its size. One it wants only for its codec is not
 * asked for — nearly every phone clip is HEVC, and a job for each would go
 * into the queue people's own requests are served from, oldest first, so a
 * press of "Make a streamable version" on a 4 GB master would wait behind
 * every clip uploaded before it. Those come to the Macs from the queue's
 * offer instead (lib/db.js listProxyJobs), after everything asked for.
 */
export function asksAtUpload(file) {
  return shouldProxy(file) && Number(file?.size) >= PROXY_MIN_BYTES;
}

/**
 * Whether shouldProxy wants `file` for how it is encoded alone: under
 * PROXY_MIN_BYTES, and some browser will not play it. Nothing asked a
 * proxy of these before the codec was kept.
 *
 * Only a worker that says it makes their copy right — `?codecs=1` on the
 * queue and on the claim (OnyxKit OnyxAPI) — is offered one or may claim
 * one, asked for or not. Onyx for Mac from before that copies an HDR clip
 * into eight bits still labelled HLG or PQ, and takes a job on its
 * battery; the server is deployed before every Mac has updated, and a
 * finished copy is not made again, while the players prefer it — Safari
 * too, where the original played. Such a Mac goes on taking what the size
 * rule asks for, as it always has. An ffmpeg worker (ffmpegArgs) says it
 * once it tone-maps.
 */
export function wantedForCodec(file) {
  return shouldProxy(file) && !(Number(file?.size) >= PROXY_MIN_BYTES);
}

// ── The rendition ───────────────────────────────────────────────────────────

/** 1080p H.264 High, AAC stereo. Everything decodes this, and nothing else is true of any other combination. */
export const PROXY_MAX_HEIGHT = 1080;
export const PROXY_CRF = 23;
/** A ceiling, not a target: CRF decides quality and this stops a grainy or high-motion shot from spiking to 40 Mbps. */
export const PROXY_MAXRATE_KBPS = 6000;
export const PROXY_AUDIO_KBPS = 128;
/**
 * A key frame every this many seconds: a seek lands within two seconds of
 * where it was asked for, rather than decoding from a key frame ten seconds
 * back. Part of the rendition (proxySpec), so a worker reads it from its
 * claim: the Mac as AVVideoMaxKeyFrameIntervalDurationKey (OnyxKit
 * ProxyTranscoder), ffmpeg as a count of frames (ffmpegArgs).
 */
export const PROXY_KEYFRAME_SECONDS = 2;
/** The rate a key frame interval is counted at when the source's is not known: 2 s at 30fps, 2.5 s at 24, 1 s at 60. */
const PROXY_DEFAULT_FPS = 30;
export const PROXY_CONTAINER = 'mp4';
export const PROXY_MIME = 'video/mp4';

/**
 * The rendition for a source of a given height.
 *
 * Never upscales. A 720p master proxied to 1080p is bigger than the original
 * and no better to look at, which is the opposite of the point.
 */
export function proxySpec({ height } = {}) {
  const h = Number(height);
  const target = Number.isFinite(h) && h > 0 ? Math.min(h, PROXY_MAX_HEIGHT) : PROXY_MAX_HEIGHT;
  return {
    // Even, because H.264 requires even dimensions in both axes and an odd one
    // fails the encode outright rather than rounding.
    height: Math.max(2, Math.floor(target / 2) * 2),
    crf: PROXY_CRF,
    maxrateKbps: PROXY_MAXRATE_KBPS,
    audioKbps: PROXY_AUDIO_KBPS,
    keyframeSeconds: PROXY_KEYFRAME_SECONDS,
    container: PROXY_CONTAINER,
    mime: PROXY_MIME,
  };
}

/**
 * Frames between key frames for a source at `fps` — { num, den } as a probe
 * reads it (metadata.fps), or a number: `seconds` of them (the spec's,
 * PROXY_KEYFRAME_SECONDS by default), rounded, so at two seconds 23.976
 * makes 48 and 59.94 makes 120. A rate that is missing or not one (outside
 * 1–1000, as lib/media.js frameFacts holds it) is counted at
 * PROXY_DEFAULT_FPS; seconds that are not a sane number are the default's.
 */
export function keyframeInterval(fps, seconds = PROXY_KEYFRAME_SECONDS) {
  const rate = typeof fps === 'number' ? fps : Number(fps?.num) / Number(fps?.den);
  const r = Number.isFinite(rate) && rate >= 1 && rate <= 1000 ? rate : PROXY_DEFAULT_FPS;
  const t = Number(seconds);
  const s = Number.isFinite(t) && t > 0 && t <= 60 ? t : PROXY_KEYFRAME_SECONDS;
  return Math.max(1, Math.round(r * s));
}

/**
 * ffmpeg arguments, as an ARRAY — never a shell string.
 *
 * An array is handed to exec without a shell, so a filename containing a quote,
 * a space or a semicolon is an argument rather than a command. Filenames here
 * come from a bucket key, which a person chose.
 *
 * Each flag earns its place:
 *
 *   -pix_fmt yuv420p    ProRes and 10-bit sources decode to yuv422p10, which no
 *                       browser plays. Without this the proxy transcodes
 *                       successfully and then will not play — the worst outcome,
 *                       because nothing reports an error.
 *   -movflags +faststart
 *                       Moves the moov atom to the front. Without it the player
 *                       must download the whole file before it can start, so
 *                       the proxy is no better than the master it replaced.
 *   -profile:v high -level 4.1
 *                       The ceiling every current browser and iOS device
 *                       decodes in hardware.
 *   -vf scale=-2:H      -2 keeps the aspect ratio AND forces an even width.
 *                       Omitted entirely when the source is already at or below
 *                       the target, so nothing is upscaled or re-sampled for
 *                       no reason.
 *   -ac 2               A 5.1 master downmixed, because AAC 5.1 in an mp4 plays
 *                       as silence in several browsers.
 *   -sn -dn             Drop subtitle and data streams: a timecode track or a
 *                       tx3g subtitle makes the mp4 muxer fail late, after the
 *                       whole video has been encoded.
 *   -g N -keyint_min N -sc_threshold 0
 *                       A key frame every spec.keyframeSeconds, and only
 *                       then: x264's own are 250 frames apart (ten seconds
 *                       at 25fps), plus one at every cut, so a seek decodes
 *                       from far back and lands late. N is frames, so it is
 *                       counted at the source's rate (`sourceFps`, the
 *                       claim's, from the file's metadata.fps) — the proxy
 *                       keeps that rate.
 *
 * Not here: tone-mapping. An HLG or PQ master needs one to SDR before
 * yuv420p — the Mac's transcoder has its decoder do it — or the copy keeps
 * an HDR picture in eight bits. ffmpeg's needs zscale (libzimg), which not
 * every build has, so a worker taking HDR sources (metadata.videoCodec.hdr)
 * must add its own.
 */
export function ffmpegArgs({ input, output, spec, sourceHeight = null, sourceFps = null }) {
  if (typeof input !== 'string' || !input) throw new Error('ffmpegArgs needs an input path.');
  if (typeof output !== 'string' || !output) throw new Error('ffmpegArgs needs an output path.');
  const s = spec || proxySpec({ height: sourceHeight });
  const src = Number(sourceHeight);
  const needsScale = !Number.isFinite(src) || src <= 0 || src > s.height;
  const gop = String(keyframeInterval(sourceFps, s.keyframeSeconds));

  return [
    '-hide_banner', '-nostdin', '-y',
    '-i', input,
    ...(needsScale ? ['-vf', `scale=-2:${s.height}`] : []),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', String(s.crf),
    '-maxrate', `${s.maxrateKbps}k`,
    // Two seconds at the ceiling: enough to absorb a burst without letting the
    // rate wander far from it.
    '-bufsize', `${s.maxrateKbps * 2}k`,
    '-g', gop,
    '-keyint_min', gop,
    '-sc_threshold', '0',
    '-profile:v', 'high',
    '-level', '4.1',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', `${s.audioKbps}k`,
    '-ac', '2',
    '-sn', '-dn',
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    output,
  ];
}

// ── The rule ────────────────────────────────────────────────────────────────

const ALLOW = { ok: true };
const deny = (status, error, code = null) => ({ ok: false, status, error, ...(code ? { code } : {}) });

/**
 * May this caller do `action`? Mirrors transcriptDecision, action for action,
 * because the two queues are the same shape and a reader who knows one should
 * not have to learn a second set of rules.
 *
 * `read` answers 404 rather than 403 when the flag is off, so a turned-off
 * feature is indistinguishable from one that was never there — a 403 tells an
 * unauthorized caller that the thing exists.
 */
export function proxyDecision(action, {
  flagOn = false, live = false, canRead = false, edit = null, canModify = false, kind = null,
} = {}) {
  const read = action === 'read';
  const mac = action === 'report' || action === 'submit';
  if (!flagOn) return read ? deny(404, 'Proxy renditions are turned off.') : deny(403, 'Proxy renditions are turned off.');
  // A Mac holding a lease on a file that has since been trashed gets 409 and a
  // code, so its worker can drop the job rather than retry it for ever.
  if (!live) return mac ? deny(409, 'This file is no longer available.', 'lost') : deny(404, 'File not found');
  if (!canRead) return deny(404, 'File not found');
  if (read) return ALLOW;
  if (!edit || !edit.ok) return deny(edit?.status || 403, edit?.reason || 'Your role cannot change files.', edit?.code);
  if (!canModify) return deny(403, 'You can view this file but not change it.');
  if (action === 'request' && !isProxyableKind(kind)) return deny(400, 'Only video files can have a proxy.');
  if (action === 'claim' && !isProxyableKind(kind)) return deny(404, 'There is no proxy job for this file.');
  return ALLOW;
}

/** What a client may be told about a job. Never the claimer's email. */
export function proxyJson(row) {
  if (!row) return { status: 'none' };
  return {
    status: row.status,
    progress: row.progress ?? null,
    error: row.error ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    size: row.size ?? null,
    // The device is shown ("Transcoding on Ricky's MacBook Pro"); the account
    // that claimed it is not, because a shared library would leak who is
    // running what.
    device: row.claimedDevice ?? null,
    requestedAt: row.requestedAt ?? null,
    finishedAt: row.finishedAt ?? null,
  };
}

/**
 * Is a finished proxy still the right one for this file?
 *
 * Measured against the key the job recorded. Replacing a file's content leaves
 * the row and changes the key, and a proxy of the previous content is worse
 * than none — it plays, and shows the wrong footage.
 */
export function isStale(row, file) {
  if (!row || row.status !== 'done') return false;
  const now = file?.storageKey || null;
  return !!row.sourceKey && !!now && row.sourceKey !== now;
}
