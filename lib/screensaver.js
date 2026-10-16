// lib/screensaver.js — the screen saver: which one runs, after how long, and
// how it is set.
//
// The choice lives in localStorage on this device, like the theme
// (lib/theme.js): a screen saver is a property of the screen in front of
// you, not of the account. The watcher in the root layout
// (app/components/screensaver/ScreensaverWatch.js) reads it, waits for the
// page to go quiet, and shows it; the picker (ScreensaverDialog.js), opened
// from the account menu, writes it. Each write is announced in this tab with
// SCREENSAVER_EVENT — a `storage` event only reaches other tabs.
//
// Dependency-free: imported by server components and by the picker, and
// run under node's test runner as it is.

export const SCREENSAVER_KEY = 'screensaver';
/** Fired on window when the choice changes in this tab (detail: the pref). */
export const SCREENSAVER_EVENT = 'onyx:screensaver';
/** Fired on window to show the screen saver now — the picker's Try it. */
export const SCREENSAVER_START_EVENT = 'onyx:screensaver-start';

/**
 * Every screen saver there is, in the order the picker lists them. `pictures`
 * ones draw the library and take the Pictures from option; `clock` ones are
 * the time already, so the Show the time option does not apply; `text` takes
 * the Message field. `group` is the heading the picker files it under.
 */
export const SAVERS = [
  { key: 'photos', name: 'Photos', group: 'Your pictures', blurb: 'Pictures from your library, one at a time, drifting slowly across the screen.', pictures: true },
  { key: 'mosaic', name: 'Mosaic', group: 'Your pictures', blurb: 'A wall of your pictures, one tile at a time turning to the next.', pictures: true },
  { key: 'clock', name: 'Clock', group: 'Time', blurb: 'The time, large, wandering slowly so it wears nowhere.', clock: true },
  { key: 'dial', name: 'Dial', group: 'Time', blurb: 'A face with a sweeping second hand.', clock: true },
  { key: 'words', name: 'Word clock', group: 'Time', blurb: '“Twenty past four”, in letters that light up.', clock: true },
  { key: 'aurora', name: 'Aurora', group: 'Light', blurb: 'The colours of the brand drifting as soft light.' },
  { key: 'orbs', name: 'Orbs', group: 'Light', blurb: 'Glowing spheres that wander and brush past each other.' },
  { key: 'embers', name: 'Embers', group: 'Light', blurb: 'Sparks rising from the bottom of the screen and fading.' },
  { key: 'stars', name: 'Starfield', group: 'Motion', blurb: 'Flying through the stars.' },
  { key: 'rain', name: 'Rain', group: 'Motion', blurb: 'Characters falling in columns.' },
  { key: 'waves', name: 'Waves', group: 'Motion', blurb: 'Slow swells crossing the screen.' },
  { key: 'lines', name: 'Lines', group: 'Motion', blurb: 'Shapes that bounce from edge to edge and leave a trail.' },
  { key: 'wordmark', name: 'Logo', group: 'Words', blurb: 'The logo bouncing from edge to edge, changing colour each time it lands.' },
  { key: 'message', name: 'Message', group: 'Words', blurb: 'Words of your own, drifting about.', text: true },
  { key: 'shuffle', name: 'Shuffle', group: 'Words', blurb: 'A different one each time.' },
];

/** Minutes the page must be quiet for, the choices offered. */
export const DELAYS = [1, 2, 5, 10, 20, 30, 60];
export const SPEEDS = ['slow', 'normal', 'fast'];
/** How much faster than its own pace each speed runs a saver. */
export const SPEED_FACTOR = { slow: 0.5, normal: 1, fast: 2 };
export const MESSAGE_MAX = 80;
export const DEFAULT_MESSAGE = 'Back soon.';

/** Off, until someone picks one. */
export const DEFAULT_PREF = Object.freeze({ saver: 'off', delay: 10, speed: 'normal', clock: false, drive: null, message: '' });

const byKey = new Map(SAVERS.map((s) => [s.key, s]));

/** The catalogue entry for `key`, or null for 'off' and for anything unknown. */
export function saverFor(key) {
  return byKey.get(key) || null;
}

/**
 * A saved preference made whole: a JSON string or an object, with junk and
 * old fields dropped and anything missing filled from the defaults. A saver
 * that no longer exists is off, not an error.
 */
export function parseScreensaverPref(raw) {
  let v = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { v = null; }
  }
  if (!v || typeof v !== 'object') return { ...DEFAULT_PREF };
  const saver = v.saver === 'off' || byKey.has(v.saver) ? v.saver : DEFAULT_PREF.saver;
  const delay = DELAYS.includes(Number(v.delay)) ? Number(v.delay) : DEFAULT_PREF.delay;
  const speed = SPEEDS.includes(v.speed) ? v.speed : DEFAULT_PREF.speed;
  const drive = typeof v.drive === 'string' && v.drive ? v.drive : null;
  // Not trimmed: the picker writes it as it is typed, trailing space and all.
  const message = typeof v.message === 'string' ? v.message.slice(0, MESSAGE_MAX) : '';
  return { saver, delay, speed, clock: v.clock === true, drive, message };
}

/** The saved preference, or the defaults. Client only. */
export function readScreensaverPref() {
  try {
    return parseScreensaverPref(localStorage.getItem(SCREENSAVER_KEY));
  } catch {
    return { ...DEFAULT_PREF };
  }
}

/**
 * Save a change (merged into what is saved) and tell this tab's watcher.
 * Returns the whole preference as saved. Client only.
 */
export function writeScreensaverPref(patch) {
  const pref = parseScreensaverPref({ ...readScreensaverPref(), ...patch });
  try {
    if (pref.saver === 'off' && pref.delay === DEFAULT_PREF.delay && pref.speed === DEFAULT_PREF.speed && !pref.clock && !pref.drive && !pref.message) {
      localStorage.removeItem(SCREENSAVER_KEY);
    } else {
      localStorage.setItem(SCREENSAVER_KEY, JSON.stringify(pref));
    }
  } catch {
    // Storage blocked: the choice still holds for this page view.
  }
  window.dispatchEvent(new CustomEvent(SCREENSAVER_EVENT, { detail: pref }));
  return pref;
}

/** Show the screen saver now, whatever the delay. Client only. */
export function startScreensaverNow() {
  window.dispatchEvent(new Event(SCREENSAVER_START_EVENT));
}

/** The saver to run for `pref`: null when off; a random one for Shuffle. */
export function pickSaver(pref, random = Math.random) {
  if (!pref || pref.saver === 'off') return null;
  if (pref.saver !== 'shuffle') return byKey.has(pref.saver) ? pref.saver : null;
  const pool = SAVERS.filter((s) => s.key !== 'shuffle').map((s) => s.key);
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

/** How long the page must be quiet, in milliseconds. */
export function delayMs(pref) {
  return (DELAYS.includes(pref?.delay) ? pref.delay : DEFAULT_PREF.delay) * 60_000;
}

/**
 * The time as the clocks show it: `time` ("10:42"), `period` ("AM", or null
 * where the locale counts to 24) and `date` ("Thursday, 15 October").
 */
export function clockParts(date, locale) {
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).formatToParts(date);
  const period = time.find((p) => p.type === 'dayPeriod')?.value || null;
  const digits = time
    .filter((p) => p.type !== 'dayPeriod' && !(p.type === 'literal' && p.value.trim() === ''))
    .map((p) => p.value).join('').trim();
  return {
    time: digits,
    period,
    date: new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(date),
  };
}

// ── The word clock ──────────────────────────────────────────────────────────
// The classic eleven-by-ten English grid: every phrase from IT IS FIVE PAST
// ONE to IT IS TEN TO TWELVE is in it, reading left to right and top to
// bottom, with the letters between as filler.

export const WORD_CLOCK_ROWS = [
  'ITLISASAMPM',
  'ACQUARTERDC',
  'TWENTYFIVEX',
  'HALFSTENFTO',
  'PASTERUNINE',
  'ONESIXTHREE',
  'FOURFIVETWO',
  'EIGHTELEVEN',
  'SEVENTWELVE',
  'TENSEOCLOCK',
];
export const WORD_CLOCK_COLS = 11;

// Each word: its row and the columns it spans. The minute words FIVE and TEN
// have their own places, apart from the hours'.
const WORDS = {
  IT: [0, 0, 1], IS: [0, 3, 4], AM: [0, 7, 8], PM: [0, 9, 10],
  A: [1, 0, 0], QUARTER: [1, 2, 8],
  TWENTY: [2, 0, 5], 'FIVE*': [2, 6, 9],
  HALF: [3, 0, 3], 'TEN*': [3, 5, 7], TO: [3, 9, 10],
  PAST: [4, 0, 3], NINE: [4, 7, 10],
  ONE: [5, 0, 2], SIX: [5, 3, 5], THREE: [5, 6, 10],
  FOUR: [6, 0, 3], FIVE: [6, 4, 7], TWO: [6, 8, 10],
  EIGHT: [7, 0, 4], ELEVEN: [7, 5, 10],
  SEVEN: [8, 0, 4], TWELVE: [8, 5, 10],
  TEN: [9, 0, 2], OCLOCK: [9, 5, 10],
};
const HOURS = ['TWELVE', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN', 'ELEVEN'];
const MINUTES = [
  [], ['FIVE*', 'PAST'], ['TEN*', 'PAST'], ['A', 'QUARTER', 'PAST'], ['TWENTY', 'PAST'], ['TWENTY', 'FIVE*', 'PAST'],
  ['HALF', 'PAST'], ['TWENTY', 'FIVE*', 'TO'], ['TWENTY', 'TO'], ['A', 'QUARTER', 'TO'], ['TEN*', 'TO'], ['FIVE*', 'TO'],
];

/**
 * Which words say the time `hours`:`minutes` (24-hour), to the five minutes
 * below: the words, in reading order, and the grid cells they light
 * (row * WORD_CLOCK_COLS + column).
 */
export function wordClock(hours, minutes) {
  const step = Math.floor(minutes / 5);
  const hour = (hours + (step >= 7 ? 1 : 0)) % 12;
  const words = ['IT', 'IS', ...MINUTES[step], HOURS[hour], ...(step === 0 ? ['OCLOCK'] : []), hours % 24 < 12 ? 'AM' : 'PM'];
  const cells = new Set();
  for (const w of words) {
    const [row, from, to] = WORDS[w];
    for (let c = from; c <= to; c++) cells.add(row * WORD_CLOCK_COLS + c);
  }
  return { words: words.map((w) => w.replace('*', '')), cells };
}

// ── Motion the savers share ─────────────────────────────────────────────────

/**
 * One step of a thing bouncing about a box, the way a DVD logo did: `s` is
 * { x, y, vx, vy, w, h } in pixels and pixels per second, `dt` seconds, the
 * box `{ width, height }`. Returns the next state and whether it hit an
 * edge this step. Pure: the caller keeps the state.
 */
export function bounce(s, dt, { width, height }) {
  let { x, y, vx, vy } = s;
  const { w, h } = s;
  x += vx * dt;
  y += vy * dt;
  let hit = false;
  const maxX = Math.max(0, width - w);
  const maxY = Math.max(0, height - h);
  if (x < 0) { x = -x; vx = Math.abs(vx); hit = true; }
  if (x > maxX) { x = Math.max(0, 2 * maxX - x); vx = -Math.abs(vx); hit = true; }
  if (y < 0) { y = -y; vy = Math.abs(vy); hit = true; }
  if (y > maxY) { y = Math.max(0, 2 * maxY - y); vy = -Math.abs(vy); hit = true; }
  return { ...s, x, y, vx, vy, hit };
}

/**
 * Where something of size `w` × `h` sits at time `t` (seconds) on a slow
 * figure-of-eight across a box, never off its edges: the clocks wander this
 * way so no pixel shows the same thing for long.
 */
export function drift(t, { width, height }, { w, h }, speed = 1) {
  const spanX = Math.max(0, width - w);
  const spanY = Math.max(0, height - h);
  const k = speed * 0.035;
  return {
    x: (spanX / 2) * (1 + Math.sin(t * k * 1.00)),
    y: (spanY / 2) * (1 + Math.sin(t * k * 1.37 + 1.1)),
  };
}
