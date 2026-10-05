// lib/pending-seek.js — where a <video> has been asked to be, kept until it
// can be there. Isomorphic and DOM-free (it is handed the element), so the
// order of events it has to survive is tested without a browser.
//
// Three things the player cannot read off the element:
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
//
// WHERE A DRAG IS GOING. Dragging the scrub bar asks for a new time on every
// pointer move, and on a long-GOP original each one is a range request and a
// decode from the keyframe before it: dozens per drag, most of them overtaken
// before they show anything. So a drag has at most one seek in flight. While
// the element is seeking only the latest target is kept, and it is made when
// the element reports `seeked`; the ones in between are never made. Where the
// browser has fastSeek (Safari, Firefox) a drag uses it, landing on a nearby
// keyframe rather than decoding up to the exact frame. Letting go is an exact
// seek — unless the drag's last was already an exact one to the same place —
// like a key, a frame step or a comment marker: those go at once, as they
// always did, and drop whatever a drag still had waiting.

/**
 * `startAt` is the deep link's time in seconds (0 for none). Returns an
 * object the player keeps for its lifetime:
 *
 *   seek(v, t)    ask `v` to be at `t`, exactly — now if it can, and in any
 *                 case once its metadata arrives
 *   scrub(v, t)   a drag asks `v` to be near `t`: made now if `v` is not
 *                 seeking, otherwise kept (the latest only) until it is done
 *   release(v, t) the drag is let go at `t`: seek(v, t), unless the drag's
 *                 own last seek was already an exact one to `t`
 *   loaded(v)     the metadata has arrived: go where the latest request
 *                 said, once. Returns that time, or null if nothing asked
 *   pending()     the time asked for before load and not yet applied, or null
 *   landed(v)     whether `v` has got where it was last asked to go: not
 *                 seeking, and nothing kept for it to go to next
 *   shown()       a seek or play has begun: from now on the stage shows the
 *                 element's own frames, not the poster
 *   presented()   whether shown() has happened
 */
export function pendingSeek(startAt = 0) {
  const start = Number(startAt);
  let wanted = Number.isFinite(start) && start > 0 ? start : null;
  // A drag's latest target while the element is busy with an earlier one,
  // and the element whose `seeked` makes it.
  let next = null;
  let bound = null;
  let presented = false;

  const go = (v, t, fast) => {
    // Older WebKit threw on a seek before metadata; the request is kept in
    // `wanted` either way, and applied by loaded(). fastSeek does nothing at
    // all before metadata, so a drag that early sets the time instead, which
    // some browsers keep.
    try {
      if (fast && v.readyState > 0 && typeof v.fastSeek === 'function') v.fastSeek(t);
      else v.currentTime = t;
    } catch { /* applied on load */ }
  };
  // The seek in flight is done: make the drag's latest. A `seeked` with
  // nothing kept is an exact seek's, or a drag's last, and needs nothing.
  const land = () => {
    if (next == null || !bound) return;
    const t = next;
    next = null;
    go(bound, t, true);
  };

  const seek = (v, t) => {
    if (!v || !Number.isFinite(t)) return;
    next = null;
    if (v.readyState === 0) wanted = t;
    go(v, t, false);
  };

  return {
    seek,
    release(v, t) {
      if (!v || !Number.isFinite(t)) return;
      // Without fastSeek the drag's own seeks were exact, and a click on the
      // bar is a drag that never moved: if the last one went to `t` and
      // nothing is waiting behind it, the element is there or on its way, and
      // a second seek would only decode the same frame again. To within a
      // microsecond: Chrome keeps the time a seek landed on to the
      // microsecond, not the double it was given. With fastSeek, currentTime
      // reads the time asked for while the approximate seek is out, so it
      // says nothing about where that seek lands.
      if (v.readyState > 0 && typeof v.fastSeek !== 'function' && next == null
        && Math.abs(v.currentTime - t) < 1e-6) return;
      seek(v, t);
    },
    scrub(v, t) {
      if (!v || !Number.isFinite(t)) return;
      // `seeking` is the element's own word, not a flag kept here: a seek cut
      // short by a new source never reports `seeked`, and the drag must not
      // wait for it.
      if (v.seeking) {
        next = t;
        if (bound !== v) {
          bound?.removeEventListener?.('seeked', land);
          v.addEventListener?.('seeked', land);
          bound = v;
        }
        return;
      }
      next = null;
      if (v.readyState === 0) wanted = t;
      go(v, t, true);
    },
    loaded(v) {
      const t = wanted;
      wanted = null;
      next = null;
      if (v && t != null) {
        try { v.currentTime = t; } catch { /* nothing more to try */ }
      }
      return t;
    },
    pending: () => wanted,
    landed: (v) => !v?.seeking && wanted == null && next == null,
    shown() { presented = true; },
    presented: () => presented,
  };
}
