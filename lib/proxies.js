// lib/proxies.js — streamable renditions of heavy masters.
//
// A 4K ProRes master streams badly from object storage: every seek is a range
// request into gigabytes, and every byte is egress. A proxy is a small H.264
// copy that plays and seeks everywhere, including iOS Safari, at roughly 5–10%
// of the size. The player prefers it and falls back to the master.
//
// Transcoding does NOT happen on the server. A Vercel function has a 250MB
// bundle and a 300s ceiling; a 40GB master will not transcode in either. The
// Mac does it — it already has the file mounted via rclone and ffmpeg to hand —
// and claims work through the same queue idiom as transcripts: a side table
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
 * Only video, and only when the master is big enough to be worth it. Under
 * this, streaming the original is fine and a proxy costs storage for nothing.
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
 * effectiveKind, not `file.kind`: a .mov uploaded before the kind was worked out
 * is stored as 'other', and that row is exactly the one that most needs a proxy.
 *
 * S3 only, because a proxy is an object in the bucket and there is nowhere to
 * put one otherwise.
 */
export function shouldProxy(file) {
  return isProxyableKind(effectiveKind(file))
    && file?.storage === 's3'
    && Number(file?.size) >= PROXY_MIN_BYTES;
}

// ── The rendition ───────────────────────────────────────────────────────────

/** 1080p H.264 High, AAC stereo. Everything decodes this, and nothing else is true of any other combination. */
export const PROXY_MAX_HEIGHT = 1080;
export const PROXY_CRF = 23;
/** A ceiling, not a target: CRF decides quality and this stops a grainy or high-motion shot from spiking to 40 Mbps. */
export const PROXY_MAXRATE_KBPS = 6000;
export const PROXY_AUDIO_KBPS = 128;
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
    container: PROXY_CONTAINER,
    mime: PROXY_MIME,
  };
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
 */
export function ffmpegArgs({ input, output, spec, sourceHeight = null }) {
  if (typeof input !== 'string' || !input) throw new Error('ffmpegArgs needs an input path.');
  if (typeof output !== 'string' || !output) throw new Error('ffmpegArgs needs an output path.');
  const s = spec || proxySpec({ height: sourceHeight });
  const src = Number(sourceHeight);
  const needsScale = !Number.isFinite(src) || src <= 0 || src > s.height;

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
