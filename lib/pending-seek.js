// lib/pending-seek.js — where a <video> has been asked to be, kept until it
// can be there. Isomorphic and DOM-free (it is handed the element), so the
// order of events it has to survive is tested without a browser.
//
// Two things the player cannot read off the element:
//
// WHERE IT WAS ASKED TO GO. Until a source has loaded (readyState 0,
// HAVE_NOTHING) a video cannot seek. The spec keeps the time as a "default
// playback start position"; not every browser does, and none keeps it past
// the player's own seek once the metadata arrives. The player used to make
// that seek to the ?t= deep link unconditionally — so a comment marker
// clicked, or a frame stepped, while a master was still loading landed on the
// deep link's frame instead, with the comment showing as selected. The latest
// request is what counts; the deep link is only the first one.
//
// WHETHER THE STAGE SHOWS A FRAME AT ALL. A <video> shows its poster until it
// first seeks or plays — even once loaded, with preload="metadata" — and the
// poster is a frame from the middle of the clip, while the player's label
// reads where playback will start. A comment made then is pinned to the
// label's frame and reopens on a different picture. So the player asks, and
// loads the frame first.

/**
 * `startAt` is the deep link's time in seconds (0 for none). Returns an
 * object the player keeps for its lifetime:
 *
 *   seek(v, t)    ask `v` to be at `t` — now if it can, and in any case once
 *                 its metadata arrives
 *   loaded(v)     the metadata has arrived: go where the latest request
 *                 said, once. Returns that time, or null if nothing asked
 *   pending()     the time asked for and not yet applied, or null
 *   shown()       a seek or play has begun: from now on the stage shows the
 *                 element's own frames, not the poster
 *   presented()   whether shown() has happened
 */
export function pendingSeek(startAt = 0) {
  const start = Number(startAt);
  let wanted = Number.isFinite(start) && start > 0 ? start : null;
  let presented = false;
  return {
    seek(v, t) {
      if (!v || !Number.isFinite(t)) return;
      if (v.readyState === 0) wanted = t;
      // Older WebKit threw on a seek before metadata; the request is kept
      // above either way, and applied by loaded().
      try { v.currentTime = t; } catch { /* applied on load */ }
    },
    loaded(v) {
      const t = wanted;
      wanted = null;
      if (v && t != null) {
        try { v.currentTime = t; } catch { /* nothing more to try */ }
      }
      return t;
    },
    pending: () => wanted,
    shown() { presented = true; },
    presented: () => presented,
  };
}
