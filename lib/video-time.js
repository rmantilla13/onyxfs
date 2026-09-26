// lib/video-time.js — the arithmetic behind a video player's controls, built
// around frames.
//
// Pure functions with no imports, so the parts that are easy to get subtly
// wrong can be tested without a browser. Every one of these has a failure mode
// that looks like a UI glitch and is really an off-by-one: a frame step that
// lands back on the frame it started from, a scrub that cannot reach the last
// pixel of the bar, a timecode that reads 00:00:60:00.
//
// THE FRAME MODEL. A moment in a clip is an integer frame index plus a
// rational frame rate, `{ num, den }` — 24000/1001, not 23.976. Seconds are
// what a <video> element speaks, so they are converted at the edges and
// nowhere else. Comments are pinned to frames, and a float rate is how a
// comment made on frame 1439 of a 23.976 clip reopens on 1438: 23.976 is not
// 24000/1001, and over a minute the difference is most of a frame.

/** Frame rate assumed when a file does not say. 25 and 24 are commoner in film, but browsers cannot tell us, and 30 is the safer guess for material shot on phones and cameras. */
export const ASSUMED_FPS = 30;
export const ASSUMED_RATE = Object.freeze({ num: 30, den: 1 });

// Rates cameras and NLEs actually produce. A rate read from a file is snapped
// to one of these when it is within 0.02%: a container with a 90 kHz
// timescale stores 23.976 as 90000/3754, which is 23.9744 and would put a
// timecode a frame out every ten minutes. 0.02% is far tighter than the gap
// between any two of them (24000/1001 and 24 are 0.1% apart).
const KNOWN_RATES = [
  [12, 1], [15, 1], [24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1],
  [48000, 1001], [48, 1], [50, 1], [60000, 1001], [60, 1], [100, 1],
  [120000, 1001], [120, 1],
];
const SNAP_TOLERANCE = 0.0002;

const gcd = (a, b) => {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
};

function snapRate(num, den) {
  const v = num / den;
  for (const [n, d] of KNOWN_RATES) {
    if (Math.abs(v - n / d) / (n / d) <= SNAP_TOLERANCE) return { num: n, den: d };
  }
  const g = gcd(num, den) || 1;
  return { num: num / g, den: den / g };
}

/**
 * A frame rate as `{ num, den }`, reduced and snapped to a standard rate, or
 * null for anything that is not one.
 *
 * Takes `{ num, den }` (what metadata stores), `"24000/1001"`, or a plain
 * number — 23.976 comes back as 24000/1001, so a rate typed by a person or
 * reported as a float still lands on the exact one.
 */
export function toRate(fps) {
  let num;
  let den;
  if (fps && typeof fps === 'object') {
    num = Number(fps.num);
    den = Number(fps.den);
  } else if (typeof fps === 'string' && fps.includes('/')) {
    [num, den] = fps.split('/').map((p) => Number(p.trim()));
  } else {
    const v = Number(fps);
    if (fps == null || fps === '' || !Number.isFinite(v) || v <= 0) return null;
    // Three decimals is how rates are written (23.976, 29.97, 59.94); the
    // snap then turns them into the exact rational.
    num = Math.round(v * 1000);
    den = 1000;
  }
  if (!Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0) return null;
  if (num > 2 ** 31 || den > 2 ** 31) return null;
  const v = num / den;
  // Nothing plays slower than a frame a second or faster than a thousand; a
  // value outside that is a misread box, and dividing by it would be worse.
  if (v < 1 || v > 1000) return null;
  return snapRate(num, den);
}

/** Frames per second as a float, for display and for nothing else. */
export function rateValue(fps) {
  const r = toRate(fps) || ASSUMED_RATE;
  return r.num / r.den;
}

/** "23.976", "29.97", "25" — how an editor writes a rate. */
export function rateLabel(fps) {
  const r = toRate(fps);
  if (!r) return '';
  return String(Number((r.num / r.den).toFixed(3)));
}

/**
 * The whole number a timecode counts frames in: 24 for 23.976, 30 for 29.97,
 * 60 for 59.94. A timecode's frame field runs 0…base-1 whatever the real rate.
 */
export function timecodeBase(fps) {
  return Math.max(1, Math.round(rateValue(fps)));
}

/** Drop-frame numbering exists only for 29.97 and 59.94. */
export function canDropFrame(fps) {
  const r = toRate(fps);
  return !!r && r.den === 1001 && (r.num === 30000 || r.num === 60000);
}

// How close to a frame's start a time must be to count as that start: a
// thousandth of a frame. See frameAt.
const FRAME_SNAP = 1e-3;

/**
 * The frame on screen at `sec`: frame n occupies [n·den/num, (n+1)·den/num).
 *
 * The time that matters most is a frame's own start — requestVideoFrameCallback
 * reports the presented frame's timestamp — and it never arrives exact. The
 * float product lands a hair under the integer (1001/24000 · 24000/1001 is
 * 0.9999999999999999), and browsers round media timestamps to the
 * microsecond: Chrome reports frame 302 of a 29.97 clip as 10.076733, which is
 * frame 301.99999. Flooring either reads the frame before, and the label and
 * every comment pinned from it are one frame early. So a time within a
 * thousandth of a frame of a start is that start — far more than microsecond
 * rounding at any real rate, far less than any real difference in time.
 */
export function frameAt(sec, fps) {
  const t = Number(sec);
  if (!Number.isFinite(t) || t <= 0) return 0;
  const r = toRate(fps) || ASSUMED_RATE;
  const x = (t * r.num) / r.den;
  const start = Math.round(x);
  return Math.abs(x - start) < FRAME_SNAP ? start : Math.floor(x);
}

/**
 * The time to seek to for frame `frame`: its MIDDLE, not its start.
 *
 * Seeking to the boundary asks the decoder for the instant one frame ends and
 * the next begins, and browsers disagree about which of the two that shows —
 * Safari rounds one way, Chrome the other, and a comment made on frame N
 * reopened on N-1 in one of them. Half a frame in is unambiguous everywhere.
 */
export function secondsOfFrame(frame, fps) {
  const n = Math.max(0, Math.floor(Number(frame) || 0));
  const r = toRate(fps) || ASSUMED_RATE;
  return ((n + 0.5) * r.den) / r.num;
}

/**
 * How many frames the clip has: the count the container recorded when there
 * is one (lib/mp4-probe.js), else the duration's worth. Infinity when neither
 * is known, so a clamp against it clamps nothing.
 */
export function frameCount({ frames, duration, fps } = {}) {
  const f = Number(frames);
  if (Number.isInteger(f) && f > 0) return f;
  const d = Number(duration);
  if (!Number.isFinite(d) || d <= 0) return Infinity;
  const r = toRate(fps) || ASSUMED_RATE;
  // ceil, less the same nudge as frameAt: 10s at 30fps is 300 frames, and the
  // float 300.00000000000006 must not become 301.
  return Math.max(1, Math.ceil((d * r.num) / r.den - 1e-6));
}

/** A frame index kept inside the clip. */
export function clampFrame(frame, total = Infinity) {
  const n = Math.floor(Number(frame) || 0);
  const last = Number.isFinite(total) ? Math.max(0, total - 1) : Infinity;
  return Math.max(0, Math.min(n, last));
}

// Drop-frame numbering skips the LABELS ;00 and ;01 (;00–;03 at 59.94) at the
// start of every minute except each tenth, so the timecode keeps pace with the
// wall clock. No frame is dropped — only numbers — so the frame index stays
// the truth and these convert between it and the label.
function dropFrameLabelCount(n, base) {
  const drop = Math.round(base / 15);        // 2 at 29.97, 4 at 59.94
  const perMinute = base * 60 - drop;        // 1798 labels in a dropping minute
  const perTen = base * 600 - drop * 9;      // 17982 frames in ten minutes
  const tens = Math.floor(n / perTen);
  const rem = n % perTen;
  return n + drop * 9 * tens + (rem > drop ? drop * Math.floor((rem - drop) / perMinute) : 0);
}

function dropFrameIndex(h, m, s, f, base) {
  const drop = Math.round(base / 15);
  const minutes = h * 60 + m;
  // A label that does not exist (01:01:00;00) means the first one that does.
  const ff = s === 0 && m % 10 !== 0 && f < drop ? drop : f;
  return (h * 3600 + m * 60 + s) * base + ff - drop * (minutes - Math.floor(minutes / 10));
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * SMPTE timecode for frame `frame` of a clip: HH:MM:SS:FF, or HH:MM:SS;FF
 * when drop-frame.
 *
 *   fps        the clip's rate — { num, den }, "24000/1001" or a number
 *   tcStart    the source timecode of frame 0, in frames (a camera's
 *              01:00:00:00 is 86400 at 24fps), so the label matches what
 *              the editor's NLE shows for the same frame
 *   dropFrame  drop-frame numbering; ignored for rates that have none
 *
 * Hours wrap at 24, as a timecode does.
 */
export function timecode(frame, { fps, tcStart = 0, dropFrame = false } = {}) {
  const r = toRate(fps) || ASSUMED_RATE;
  const base = timecodeBase(r);
  const df = !!dropFrame && canDropFrame(r);
  const f = Number(frame);
  const start = Number.isInteger(Number(tcStart)) && Number(tcStart) > 0 ? Number(tcStart) : 0;
  let n = (Number.isFinite(f) && f > 0 ? Math.floor(f) : 0) + start;
  if (df) n = dropFrameLabelCount(n, base);
  const secs = Math.floor(n / base);
  // Two digits for the frame field up to 99fps; 100 and 120 need three.
  const fw = Math.max(2, String(base - 1).length);
  return `${pad(Math.floor(secs / 3600) % 24)}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}${df ? ';' : ':'}${pad(n % base, fw)}`;
}

/**
 * Text → a frame index in the clip, or null for anything unparseable.
 *
 *   "01:00:12:04" / "01:00:12;04"  SMPTE, read against the clip's start
 *                                  timecode. A `;` means drop-frame, as it
 *                                  does in every NLE.
 *   "90", "1:30", "0:01.5"          clock time from the start of the clip
 *
 * A SMPTE time before the clip's start timecode is read as counting from the
 * clip's first frame instead: links made before start timecodes were known
 * ran from 00:00:00:00, and they should keep opening where they did.
 *
 * `opts` is `{ fps, tcStart, dropFrame }`; a bare rate is accepted too.
 */
export function parseTimecode(text, opts = {}) {
  const o = opts && typeof opts === 'object' && !('num' in opts) ? opts : { fps: opts };
  const s = String(text ?? '').trim();
  if (!s) return null;
  const r = toRate(o.fps) || ASSUMED_RATE;
  const parts = s.split(/[:;]/);
  if (parts.length > 4 || parts.some((p) => p === '' || !/^\d+(\.\d+)?$/.test(p))) return null;

  // Four parts is HH:MM:SS:FF; fewer is clock time, where the last part may
  // carry a fraction. Treating HH:MM:SS:FF as clock time would read frame 12
  // as twelve seconds.
  if (parts.length === 4) {
    if (parts.some((p) => p.includes('.'))) return null;
    const [h, m, sec, f] = parts.map(Number);
    const base = timecodeBase(r);
    if (m > 59 || sec > 59 || f >= base) return null;
    const df = (s.includes(';') || !!o.dropFrame) && canDropFrame(r);
    const absolute = df ? dropFrameIndex(h, m, sec, f, base) : (h * 3600 + m * 60 + sec) * base + f;
    const start = Number.isInteger(Number(o.tcStart)) && Number(o.tcStart) > 0 ? Number(o.tcStart) : 0;
    return absolute >= start ? absolute - start : absolute;
  }
  if (s.includes(';')) return null;
  const seconds = parts.map(Number).reduce((acc, n) => acc * 60 + n, 0);
  return frameAt(seconds, r);
}

/**
 * The time one frame later or earlier, clamped to the clip, as the middle of
 * that frame (see secondsOfFrame).
 *
 * Moves by frame index, not by 1/fps: stepping by a float from an arbitrary
 * currentTime lands mid-frame at a different offset each time, and two steps
 * forward and two back did not come home.
 */
export function stepFrame(current, direction, { fps, duration = Infinity, frames } = {}) {
  const r = toRate(fps) || ASSUMED_RATE;
  const dir = direction < 0 ? -1 : 1;
  const total = frameCount({ frames, duration, fps: r });
  return secondsOfFrame(clampFrame(frameAt(current, r) + dir, total), r);
}

/** Time under a pointer at `clientX` over a bar `rect`. */
export function timeFromPointer(clientX, rect, duration) {
  const width = rect?.width || 0;
  const total = Number(duration);
  if (!width || !Number.isFinite(total) || total <= 0) return 0;
  // Clamped to [0,1]: a pointer drag continues outside the element, and an
  // unclamped ratio seeks past the end or to a negative time.
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / width));
  return ratio * total;
}

/** A time as a percentage of duration, for positioning something on the bar. */
export function percentOf(time, duration) {
  const total = Number(duration);
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, (Number(time) || 0) / total * 100));
}

/**
 * The buffered ranges as percentage spans, for painting them behind the
 * progress fill.
 *
 * Takes anything array-like with length/start/end so a TimeRanges can be
 * passed straight in and a plain array can be passed in a test.
 */
export function bufferedSpans(buffered, duration) {
  const total = Number(duration);
  if (!buffered || !Number.isFinite(total) || total <= 0) return [];
  const spans = [];
  const length = buffered.length ?? 0;
  for (let i = 0; i < length; i++) {
    const start = typeof buffered.start === 'function' ? buffered.start(i) : buffered[i]?.start;
    const end = typeof buffered.end === 'function' ? buffered.end(i) : buffered[i]?.end;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const left = percentOf(start, total);
    spans.push({ left, width: Math.max(0, percentOf(end, total) - left) });
  }
  return spans;
}

/**
 * Keep an in/out selection sane.
 *
 * `out` is never allowed to sit at or before `in`: a zero-length or inverted
 * range reads as a bug everywhere downstream — a duration of 0, a loop that
 * never advances, a deep link that opens and immediately ends.
 */
export function clampRange({ inPoint, outPoint }, duration, { minLength = 1 / ASSUMED_FPS } = {}) {
  const total = Number.isFinite(Number(duration)) && Number(duration) > 0 ? Number(duration) : 0;
  if (!total) return { inPoint: null, outPoint: null };
  const lo = inPoint == null ? null : Math.min(Math.max(0, Number(inPoint)), total);
  const hi = outPoint == null ? null : Math.min(Math.max(0, Number(outPoint)), total);
  if (lo == null || hi == null) return { inPoint: lo, outPoint: hi };
  if (hi - lo >= minLength) return { inPoint: lo, outPoint: hi };
  // Too short or inverted: push whichever end has room, so setting out before
  // in nudges rather than silently doing nothing.
  return lo + minLength <= total
    ? { inPoint: lo, outPoint: lo + minLength }
    : { inPoint: Math.max(0, total - minLength), outPoint: total };
}

/** Shuttle rates for repeated J / L presses, the way an NLE does it. */
export const SHUTTLE_RATES = [1, 2, 4, 8, 16];

export function shuttleRate(presses) {
  const n = Math.max(1, Math.floor(Number(presses) || 1));
  return SHUTTLE_RATES[Math.min(n, SHUTTLE_RATES.length) - 1];
}

/** Seek target for the number keys: 3 → 30% of the way in. */
export function seekToDigit(digit, duration) {
  // Checked before Number(): null, '' and false all coerce to 0, so a missing
  // or malformed key would have seeked to the start of the clip rather than
  // doing nothing.
  if (typeof digit !== 'number' && typeof digit !== 'string') return null;
  if (typeof digit === 'string' && digit.trim() === '') return null;
  const d = Number(digit);
  const total = Number(duration);
  if (!Number.isInteger(d) || d < 0 || d > 9 || !Number.isFinite(total) || total <= 0) return null;
  return total * (d / 10);
}
