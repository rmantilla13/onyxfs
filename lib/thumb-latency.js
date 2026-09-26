// lib/thumb-latency.js — how long thumbnails are taking to arrive, here and now.
//
// The grid mounts rows beyond the viewport so their pictures are loaded and
// decoded before they come into view. How far ahead that has to be depends on
// how long a picture takes: on a fast link a few rows each side is plenty,
// and reaching further only moves work around; on a 4G link a picture asked
// for four rows ahead can still be arriving as its row scrolls in, and the
// compositor then shows frames without the page's update. So the grid leans
// its rows ahead of the scroll when pictures are slow (FileGrid,
// lib/virtual-rows.js overscanFor), judged from what they actually took.
//
// A running average of the resource timings of `_thumbs/` requests (their
// duration is exposed cross-origin without Timing-Allow-Origin). Browser
// only; elsewhere it reads 0.

const SLOW_MS = 30;
const ALPHA = 0.2;
let avg = 0;
let seen = 0;
let observing = false;

export function recordThumbLatency(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return;
  avg = seen ? avg + ALPHA * (v - avg) : v;
  seen++;
}

/** The running average, in ms (0 before any thumbnail has arrived). */
export function thumbLatency() {
  return avg;
}

/** Whether pictures are arriving slowly enough to look further ahead for them. */
export function thumbsAreSlow({ threshold = SLOW_MS } = {}) {
  return seen >= 3 && avg > threshold;
}

/** Start listening to the page's resource timings (once). */
export function observeThumbLatency() {
  if (observing || typeof PerformanceObserver === 'undefined') return;
  observing = true;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.name.includes('/_thumbs/') && e.duration > 0) recordThumbLatency(e.duration);
    }).observe({ type: 'resource', buffered: true });
  } catch { observing = false; }
}

/** For tests: forget everything. */
export function resetThumbLatency() {
  avg = 0;
  seen = 0;
}
