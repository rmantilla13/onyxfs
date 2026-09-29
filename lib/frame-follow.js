// lib/frame-follow.js — the frame a <video> is showing, and how often the
// player says so. Isomorphic and DOM-free, like lib/pending-seek.js, so the
// order of events it has to survive is tested without a browser.
//
// requestVideoFrameCallback fires once for every frame presented: 24 to 60
// times a second while a clip plays, twice that at double speed. The player
// set its state from each one, and so re-rendered all of itself — the
// controls, the scrub bar, the review overlay — at the frame rate: the
// heaviest thing on a page that is playing, spent on a timecode nobody can
// read that fast.
//
// So the frame is kept exactly, always, because a step, In and Out, a comment
// and the review panel act on the frame on screen. What is painted — the
// label, and everything else that renders from it — follows:
//
//   while playing   at most LABEL_HZ times a second
//   while paused    every frame presented: a seek, a step or a scrub shows
//                   the frame it landed on
//   on pause        once more, with the frame playback stopped on, so the
//                   label never rests on one painted a few frames before

export const LABEL_HZ = 15;

/**
 * `paint(frame)` is how the label changes (the player's state setter), and
 * `start` the frame it shows first. Returns an object the player keeps for
 * its lifetime:
 *
 *   onFrame(f, now, paused)  frame `f` was presented at `now` (ms, the
 *                            callback's clock): kept, and painted if paused
 *                            or if the last paint was long enough ago
 *   set(f)                   moved from outside — a seek before the source
 *                            loads, a step: kept and painted at once
 *   settle()                 playback paused: paint the frame kept
 *   frame()                  the frame on screen, exactly
 */
export function frameFollower(paint, { start = 0, hz = LABEL_HZ } = {}) {
  // Less a millisecond: the callback runs on the display's clock, which
  // jitters, and a frame due a whole interval after the last paint should not
  // wait one frame more for arriving a hair early.
  const gap = 1000 / hz - 1;
  let exact = start;
  let paintedAt = -Infinity;
  return {
    onFrame(f, now, paused) {
      exact = f;
      if (!paused && now - paintedAt < gap) return;
      paintedAt = now;
      paint(f);
    },
    set(f) {
      exact = f;
      paint(f);
    },
    settle() {
      paint(exact);
    },
    frame: () => exact,
  };
}
