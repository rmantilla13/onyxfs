// lib/backfill-quiet.js — how the background backfills stay out of the way:
// the thumbnail one (lib/thumbnail-client.js) and the waveform one
// (lib/waveform-client.js), which decode on the main thread.

/**
 * Whether the connection has asked to save data. Remaking a thumbnail that is
 * merely small re-reads the original, so it is not done then; nor are
 * siblings, which only save bytes later; nor is a waveform, which downloads
 * the sound.
 */
export function saveData() {
  try { return !!navigator.connection?.saveData; } catch { return false; }
}

// A backfill job starts only when the page is idle, and waits while it is
// being scrolled (a scroll event in the last 150 ms) or pressed, so it never
// lands in the middle of a gesture.
const QUIET_MS = 150;
let lastScroll = 0;
let pointerDown = false;
let watching = false;

/** Start listening for scrolls and presses — once per page, whoever asks. */
export function watchActivity() {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  window.addEventListener('scroll', () => { lastScroll = performance.now(); }, { passive: true, capture: true });
  window.addEventListener('pointerdown', () => { pointerDown = true; }, { passive: true, capture: true });
  const up = () => { pointerDown = false; };
  window.addEventListener('pointerup', up, { passive: true, capture: true });
  window.addEventListener('pointercancel', up, { passive: true, capture: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function idle() {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 2000 });
    else setTimeout(resolve, 50);
  });
}

/** Resolves once the page is idle and nobody is scrolling or pressing — or after a minute or so regardless. */
export async function whenQuiet() {
  for (let i = 0; i < 400; i++) {
    await idle();
    if (!pointerDown && performance.now() - lastScroll > QUIET_MS) return;
    await sleep(QUIET_MS);
  }
}
