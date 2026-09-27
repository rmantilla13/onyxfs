// lib/transcripts.js — video and audio transcripts: the rules and the formats.
//
// Transcription happens on a Mac, never here: Onyx for Mac claims a queued
// job, downloads the file, transcribes it with Apple's speech frameworks and
// uploads the segments. The server keeps the queue and the result; the web
// shows, searches, captions and exports them. The contract between the two
// halves is fixed (routes, fields, limits), and this module is its pure half:
//
//   normalize*          what a request body may carry, cleaned or refused
//   transcriptDecision  who may do what to a file's transcript, as a matrix
//   transcriptJson      a stored row as the API's body, `stale` included
//   toSRT, toVTT, toText  the exports, and the captions track
//   segmentAt, matchRanges, findMatches  the panel's playhead and search
//
// No imports, and nothing that reaches the server: the browser imports this
// for the formatters and the search, the routes for the rules. The queries
// are lib/db.js's; the lookups a route makes are lib/transcript-guard.js's.

export const TRANSCRIPT_STATUSES = ['queued', 'working', 'done', 'failed'];

// A claim holds a job this long, and every progress report extends it by the
// same again. The SQL writes it as interval '10 minutes' (lib/db.js); the two
// are kept in step by a test.
export const LEASE_SECONDS = 600;

export const MAX_SEGMENTS = 20000;
export const MAX_SEGMENT_CHARS = 1000;
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_ERROR_CHARS = 500;
export const MAX_DEVICE_CHARS = 80;
// How many jobs the queue hands a Mac at a time.
export const QUEUE_LIMIT = 10;

/** Whether a file of this kind (lib/media.js effectiveKind) can be transcribed. */
export const isTranscribableKind = (kind) => kind === 'video' || kind === 'audio';

// The languages the web offers when asking for a transcript. Anything else
// BCP-47 is accepted by the API; this is only the short list for the menu.
// null — the default — is "the Mac's own language".
export const TRANSCRIPT_LANGUAGES = [
  { tag: 'en-US', label: 'English (US)' },
  { tag: 'en-GB', label: 'English (UK)' },
  { tag: 'es-ES', label: 'Spanish' },
  { tag: 'fr-FR', label: 'French' },
  { tag: 'de-DE', label: 'German' },
  { tag: 'it-IT', label: 'Italian' },
  { tag: 'pt-BR', label: 'Portuguese (Brazil)' },
  { tag: 'nl-NL', label: 'Dutch' },
  { tag: 'ja-JP', label: 'Japanese' },
  { tag: 'ko-KR', label: 'Korean' },
  { tag: 'zh-CN', label: 'Chinese (Mandarin)' },
];

// ── Request bodies ──────────────────────────────────────────────────────────

// Control characters and runs of whitespace become one space: a segment is
// one line of a caption, and a stray newline would end an SRT or VTT cue
// early. Kept to one pass so 20,000 segments clean in a few milliseconds.
const squash = (s) => String(s).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
const chars = (s) => {
  let n = 0;
  for (const _ of s) n++; // code points, not UTF-16 units: "1000 characters" of Japanese is 1000
  return n;
};
const clip = (s, max) => {
  if (s.length <= max) return s;
  return [...s].slice(0, max).join('');
};
const round3 = (n) => Math.round(n * 1000) / 1000;

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

/**
 * A requested or reported language: a BCP-47 tag ("en-US"; an underscore is
 * read as a hyphen, as Apple's locale identifiers write it), or null for none.
 * → { value } or { error }.
 */
export function normalizeLanguage(input) {
  if (input == null || input === '') return { value: null };
  if (typeof input !== 'string') return { error: 'The language must be a tag like "en-US".' };
  const tag = input.trim().replace(/_/g, '-');
  if (!tag) return { value: null };
  if (tag.length > 35 || !LANGUAGE_TAG.test(tag)) return { error: 'The language must be a tag like "en-US".' };
  return { value: tag };
}

/** The engine a Mac says it used: a short identifier, or null. → { value } or { error }. */
export function normalizeEngine(input) {
  if (input == null || input === '') return { value: null };
  if (typeof input !== 'string' || input.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input)) {
    return { error: 'The engine must be a short name like "apple-speechanalyzer".' };
  }
  return { value: input };
}

/** The storage key a Mac transcribed, echoed back from its claim. → { value } or { error }. */
export function normalizeSourceKey(input) {
  if (input == null || input === '') return { value: null };
  if (typeof input !== 'string' || input.length > 1024) return { error: 'sourceKey must be the key the claim handed out.' };
  return { value: input };
}

/** The Mac's name as it reports it, cleaned and cut to 80 characters; null for none. */
export function normalizeDevice(input) {
  if (typeof input !== 'string') return null;
  const name = clip(squash(input), MAX_DEVICE_CHARS).trim();
  return name || null;
}

/** A progress report: a finite number, held to 0..1; null when it is not one. */
export function progressValue(input) {
  if (typeof input !== 'number' || !Number.isFinite(input)) return null;
  return Math.min(1, Math.max(0, input));
}

/**
 * Why a run failed, as the Mac said it, cut to 500 characters. Cut rather
 * than refused: a failure report turned away with a 400 would leave the job
 * "working" until its lease ran out, and nobody would learn why.
 *
 * `fallback` is what a worker that said nothing gets, and the reason this takes
 * one: the proxy queue shares this function (lib/proxies.js) and a proxy that
 * failed must not read "Transcription failed."
 */
export function failureMessage(input, fallback = 'Transcription failed.') {
  const text = typeof input === 'string' ? clip(squash(input), MAX_ERROR_CHARS).trim() : '';
  return text || fallback;
}

/**
 * The segments of a submitted transcript, checked and normalised:
 * `{ s, e, t }` with start and end in seconds (finite, ≥ 0, e ≥ s, rounded to
 * 3 decimals) and 1–1000 characters of text (whitespace collapsed), in time
 * order. At most 20,000. → { segments } or { error } naming the first bad one.
 *
 * Refused rather than repaired: a segment that ends before it starts is a
 * bug on the Mac, and storing a guess would hide it.
 */
export function normalizeSegments(input) {
  if (!Array.isArray(input)) return { error: '"segments" must be a list of { s, e, t }.' };
  if (input.length > MAX_SEGMENTS) {
    return { error: `A transcript can have at most ${MAX_SEGMENTS.toLocaleString('en-US')} segments; this one has ${input.length.toLocaleString('en-US')}.` };
  }
  const out = new Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const seg = input[i];
    const n = i + 1;
    if (!seg || typeof seg !== 'object' || Array.isArray(seg)) return { error: `Segment ${n} is not a { s, e, t } object.` };
    const { s, e, t } = seg;
    if (typeof s !== 'number' || typeof e !== 'number' || !Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e < 0) {
      return { error: `Segment ${n} needs a start and an end in seconds, 0 or more.` };
    }
    const start = round3(s);
    const end = round3(e);
    if (end < start) return { error: `Segment ${n} ends before it starts.` };
    if (typeof t !== 'string') return { error: `Segment ${n} has no text.` };
    const text = squash(t);
    if (!text) return { error: `Segment ${n} has no text.` };
    if (text.length > MAX_SEGMENT_CHARS && chars(text) > MAX_SEGMENT_CHARS) {
      return { error: `Segment ${n} is longer than ${MAX_SEGMENT_CHARS} characters.` };
    }
    out[i] = { s: start, e: end, t: text };
  }
  // Time order, which every reader assumes (segmentAt, the exports). Stable,
  // so two segments at the same instant keep the order they came in.
  out.sort((a, b) => a.s - b.s || a.e - b.e);
  return { segments: out };
}

/** The segments as one string, for search (the `text` column). */
export function segmentsText(segments = []) {
  return segments.map((x) => x.t).join(' ');
}

// ── Who may do what ─────────────────────────────────────────────────────────

const ALLOW = Object.freeze({ ok: true });
const deny = (status, error, code) => ({ ok: false, status, error, ...(code ? { code } : {}) });

/**
 * May this person do `action` to this file's transcript? Pure, from what the
 * route looked up (lib/transcript-guard.js) — so the whole rule is tested as
 * a matrix, not trusted.
 *
 *   read     GET — anyone who can see the file (drives, visibility, grants)
 *   request  POST, a first request or a re-request
 *   delete   DELETE
 *   claim    POST …/claim — a Mac taking a queued job
 *   report   PATCH — progress, or a failure
 *   submit   PUT — the result
 *
 * Every action but read takes the files.edit capability (`edit`, can()'s
 * answer) AND write access to this file (`canModify`: canModifyFile, which
 * applies the drive boundary). Only video and audio can be requested or
 * claimed. The flag is read on the server: off, a read is a 404 and
 * everything else a 403.
 *
 * A file that is gone or in the trash is 404 for everyone — except a Mac
 * reporting on a job it holds, which is told its job is lost (409), the one
 * answer the contract has it stop on. A file the caller cannot see is 404
 * too, never 403: a refusal would confirm that the id exists.
 */
export function transcriptDecision(action, {
  flagOn = false, live = false, canRead = false, edit = null, canModify = false, kind = null,
} = {}) {
  const read = action === 'read';
  const mac = action === 'report' || action === 'submit';
  if (!flagOn) return read ? deny(404, 'Transcripts are turned off.') : deny(403, 'Transcripts are turned off.');
  if (!live) return mac ? deny(409, 'This file is no longer available.', 'lost') : deny(404, 'File not found');
  if (!canRead) return deny(404, 'File not found');
  if (read) return ALLOW;
  if (!edit || !edit.ok) return deny(edit?.status || 403, edit?.reason || 'Your role cannot change files.', edit?.code);
  if (!canModify) return deny(403, 'You can view this file but not change it.');
  if (action === 'request' && !isTranscribableKind(kind)) return deny(400, 'Only video and audio files can be transcribed.');
  if (action === 'claim' && !isTranscribableKind(kind)) return deny(404, 'There is no transcription job for this file.');
  return ALLOW;
}

// ── The API's shape ─────────────────────────────────────────────────────────

/**
 * Whether a finished transcript is of an earlier version of the file: its
 * source key (the file's storage key when the job was claimed, or as
 * submitted) is not the file's key now. Computed, never stored.
 */
export function isStale(row, file) {
  if (!row || row.status !== 'done' || !file) return false;
  return (row.sourceKey || null) !== (file.storageKey || null);
}

const iso = (v) => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * A stored row (lib/db.js shapeTranscript) as the `transcript` of the API's
 * body, or null. Who claimed it (an email), its source key, the search text
 * and the lease stay on the server.
 */
export function transcriptJson(row, file = null) {
  if (!row) return null;
  const progress = row.progress == null ? null : Number(row.progress);
  return {
    status: row.status,
    language: row.language || null,
    resultLanguage: row.resultLanguage || null,
    engine: row.engine || null,
    segments: Array.isArray(row.segments) ? row.segments : [],
    progress: Number.isFinite(progress) ? progress : null,
    error: row.error || null,
    stale: isStale(row, file),
    requestedBy: row.requestedBy || null,
    requestedAt: iso(row.requestedAt),
    claimedDevice: row.claimedDevice || null,
    finishedAt: iso(row.finishedAt),
    updatedAt: iso(row.updatedAt),
  };
}

// ── Formats ─────────────────────────────────────────────────────────────────

/** Seconds as HH:MM:SS<sep>mmm, the timestamp both caption formats use. */
export function cueTime(seconds, sep = '.') {
  const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

/** SubRip: numbered cues, comma before the milliseconds. */
export function toSRT(segments = []) {
  return segments
    .map((x, i) => `${i + 1}\n${cueTime(x.s, ',')} --> ${cueTime(x.e, ',')}\n${x.t}\n`)
    .join('\n');
}

// A cue's text may not hold "-->" or a bare "<" or "&" (they begin markup).
// Escaping ">" takes care of the first.
const vttText = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** WebVTT: what a <track> reads, and the export. */
export function toVTT(segments = []) {
  const cues = segments.map((x) => `${cueTime(x.s)} --> ${cueTime(x.e)}\n${vttText(x.t)}\n`);
  return `WEBVTT\n\n${cues.join('\n')}`;
}

/** Plain text, a segment to a line: what Copy text and the TXT export give. */
export function toText(segments = []) {
  return segments.length ? `${segments.map((x) => x.t).join('\n')}\n` : '';
}

/** A file's name without its extension, for "Interview.srt". */
export function exportName(fileName, ext) {
  const base = String(fileName || 'transcript').replace(/\.[^./\\]{1,8}$/, '') || 'transcript';
  return `${base}.${ext}`;
}

/**
 * A segment's time for the panel: m:ss, or h:mm:ss when `long` (the whole
 * transcript runs past an hour, so every row lines up).
 */
export function clockLabel(seconds, long = false) {
  const t = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = String(s).padStart(2, '0');
  return long || h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// ── The playhead and search ─────────────────────────────────────────────────

/**
 * The segment being spoken at `time`: the last one to have started, or -1
 * before the first. It stays lit through a pause until the next begins,
 * which reads better than a highlight that blinks off between sentences.
 * `segments` in time order (normalizeSegments).
 */
export function segmentAt(segments = [], time) {
  const t = Number(time);
  if (!segments.length || !Number.isFinite(t) || t < segments[0].s) return -1;
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid].s <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const ASCII = /^[\x00-\x7f]*$/;

/**
 * Text folded for matching — lower case, accents off, so "resume" finds
 * "Résumé" — and where each folded character came from in the original, so
 * a match can be highlighted there. `map` is null when the fold kept every
 * position (plain ASCII, nearly every English transcript).
 */
export function foldText(text) {
  const src = String(text || '');
  if (ASCII.test(src)) return { folded: src.toLowerCase(), map: null };
  let folded = '';
  const map = [];
  for (let i = 0; i < src.length;) {
    const ch = String.fromCodePoint(src.codePointAt(i));
    const f = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
    i += ch.length;
  }
  map.push(src.length);
  return { folded, map };
}

/**
 * Where `query` occurs in `text`, as [start, end) ranges of the original
 * string, left to right and not overlapping. `folded` is foldText(text), for
 * a caller that searches the same text again and again.
 */
export function matchRanges(text, query, folded = null) {
  const q = foldText(String(query || '').trim()).folded;
  if (!q) return [];
  const { folded: hay, map } = folded || foldText(text);
  const at = (i) => (map ? map[i] : i);
  const out = [];
  for (let from = 0, i = hay.indexOf(q); i !== -1; i = hay.indexOf(q, from)) {
    out.push([at(i), at(i + q.length)]);
    from = i + q.length;
  }
  return out;
}

/**
 * Every occurrence of `query` in the transcript, in order: { index, range }
 * where `index` is the segment. `folded` is the segments' foldText results,
 * made once per transcript rather than once per keystroke.
 */
export function findMatches(segments = [], query, folded = null) {
  const out = [];
  if (!String(query || '').trim()) return out;
  for (let i = 0; i < segments.length; i++) {
    for (const range of matchRanges(segments[i].t, query, folded ? folded[i] : null)) out.push({ index: i, range });
  }
  return out;
}
