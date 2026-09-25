// lib/video-time.js — the arithmetic behind a video player's controls.
//
// Pure functions with no imports, so the parts that are easy to get subtly
// wrong can be tested without a browser. Every one of these has a failure mode
// that looks like a UI glitch and is really an off-by-one: a frame step that
// lands back on the frame it started from, a scrub that cannot reach the last
// pixel of the bar, a timecode that reads 00:00:60:00.

/** Frame rate assumed when a file does not say. 25 and 24 are commoner in film, but browsers cannot tell us, and 30 is the safer guess for material shot on phones and cameras. */
export const ASSUMED_FPS = 30;

/**
 * SMPTE-style timecode: HH:MM:SS:FF.
 *
 * Non-drop-frame, and deliberately so. Drop-frame renumbers frames to keep
 * 29.97 footage in step with the clock, and guessing which convention a file
 * follows would put the label out by seconds on long material. This counts
 * real frames from zero, which is what a scrub bar needs.
 */
export function timecode(seconds, fps = ASSUMED_FPS) {
  const rate = Number(fps) > 0 ? Number(fps) : ASSUMED_FPS;
  const t = Number(seconds);
  if (!Number.isFinite(t) || t < 0) return `00:00:00:00`;
  const whole = Math.floor(t);
  // Round, not floor: at 30fps a currentTime of 1.9999 is frame 30 of second
  // 1, not frame 29 — and floor makes the label stick one frame behind the
  // picture for the whole second.
  let frames = Math.round((t - whole) * rate);
  let secs = whole;
  if (frames >= rate) { frames -= Math.floor(rate); secs += 1; }
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return [pad(Math.floor(secs / 3600)), pad(Math.floor((secs % 3600) / 60)), pad(secs % 60), pad(frames)].join(':');
}

/** "1:02:05.5" or "00:01:23:12" → seconds. Returns null for anything unparseable. */
export function parseTimecode(text, fps = ASSUMED_FPS) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const parts = s.split(':');
  if (parts.length > 4 || parts.some((p) => p === '' || !/^\d+(\.\d+)?$/.test(p))) return null;
  const rate = Number(fps) > 0 ? Number(fps) : ASSUMED_FPS;
  // Four parts is HH:MM:SS:FF; fewer is clock time, where the last part may
  // carry a fraction. Treating HH:MM:SS:FF as clock time would read frame 12
  // as twelve seconds.
  if (parts.length === 4) {
    const [h, m, sec, f] = parts.map(Number);
    return h * 3600 + m * 60 + sec + f / rate;
  }
  return parts.map(Number).reduce((acc, n) => acc * 60 + n, 0);
}

/** One frame later or earlier, clamped to [0, duration]. */
export function stepFrame(current, direction, { fps = ASSUMED_FPS, duration = Infinity } = {}) {
  const rate = Number(fps) > 0 ? Number(fps) : ASSUMED_FPS;
  const t = Number(current) || 0;
  const dir = direction < 0 ? -1 : 1;
  // Snap to the frame grid first, then move. Without this, stepping from an
  // arbitrary currentTime advances by 1/fps and lands mid-frame, so two steps
  // forward and two back do not return to the start.
  const frame = Math.round(t * rate);
  const next = (frame + dir) / rate;
  // Clamp high FIRST, then low. The other order read
  // `Math.min(Math.max(0, next), duration)` with duration defaulting to
  // Infinity — and `Number.isFinite(duration) ? duration : next` then made the
  // upper bound `next` itself, so stepping back from 0 returned -1/fps. A
  // negative currentTime is silently ignored by some browsers and throws in
  // others; either way the first frame could not be stepped away from and back.
  const total = Number.isFinite(duration) ? duration : Infinity;
  return Math.max(0, Math.min(next, total));
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
