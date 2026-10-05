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
// keyframe — or in WebKit on the frame already showing, when that is on the
// way — rather than decoding up to the exact frame. On a long-GOP original
// either can be twenty seconds from the pointer, so such a landing has not
// arrived. WebKit says otherwise: its currentTime reads the time a fastSeek
// was asked for, not the frame on screen, so where one landed is not read off
// the element. A drag that stops, still held, is sought exactly where it
// stopped, and so is letting go — unless the latest seek was already an exact
// one to the same place, as a click's press is. A press, a key, a frame step
// or a comment marker goes exactly and at once, as it always did, and drops
// whatever a drag still had waiting.

/**
 * `startAt` is the deep link's time in seconds (0 for none). Returns an
 * object the player keeps for its lifetime:
 *
 *   seek(v, t)    ask `v` to be at `t`, exactly — now if it can, and in any
 *                 case once its metadata arrives
 *   scrub(v, t)   a drag asks `v` to be near `t`: made now if `v` is not
 *                 seeking, otherwise kept (the latest only) until it is done
 *   rest(v, t)    the drag has stopped at `t`, still held: seek(v, t) if the
 *                 drag's seeks leave `v` near `t` rather than on it
 *   release(v, t) the drag is let go at `t`: seek(v, t), unless the latest
 *                 seek made was already an exact one to `t`
 *   loaded(v)     the metadata has arrived: go where the latest request
 *                 said, once. Returns that time, or null if nothing asked
 *   pending()     the time asked for before load and not yet applied, or null
 *   onTarget(v)   whether the seek `v` has finished put the frame it was
 *                 sent to on screen: an exact one does, an approximate one
 *                 (fastSeek) shows whatever frame it found on the way
 *   landed(v)     whether `v` has got where it was last asked to go: not
 *                 seeking, nothing kept for it to go to next, and on target
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
  // The latest seek made: where to, and whether it was approximate (fastSeek),
  // which lands on a keyframe near `t` rather than on `t`.
  let made = null;
  let presented = false;

  // fastSeek does nothing at all before metadata, so a drag that early sets
  // the time instead, which some browsers keep.
  const fastable = (v) => v.readyState > 0 && typeof v.fastSeek === 'function';
  const go = (v, t, fast) => {
    const approx = fast && fastable(v);
    // WebKit makes no seek to the time its currentTime reads — and after a
    // fastSeek that is the time asked for, with whatever frame the seek found
    // on screen. Letting go where the drag's last move went left that frame
    // there, up to a GOP away, and then read its time. A microsecond on is
    // another time to WebKit and the same frame to the decoder.
    const nudge = !approx && made?.approx && v.readyState > 0 && v.currentTime === t;
    made = { t, approx };
    // Older WebKit threw on a seek before metadata; the request is kept in
    // `wanted` either way, and applied by loaded().
    try {
      if (approx) v.fastSeek(t);
      else v.currentTime = nudge ? t + 1e-6 : t;
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
  const onTarget = (v) => !!v && !v.seeking && !made?.approx;

  const seek = (v, t) => {
    if (!v || !Number.isFinite(t)) return;
    next = null;
    if (v.readyState === 0) wanted = t;
    go(v, t, false);
  };

  return {
    seek,
    rest(v, t) {
      if (!v || !Number.isFinite(t)) return;
      // A drag that stops to look is shown the frame it stopped on, as it was
      // before its seeks were approximate. Where they are exact, its latest is
      // there, on its way, or kept for the next `seeked`, and nothing is made.
      const approx = next != null ? fastable(v) : made?.approx;
      if (approx) seek(v, t);
    },
    release(v, t) {
      if (!v || !Number.isFinite(t)) return;
      // A click on the bar is a press that never moved, and a held drag may
      // have been sought exactly where it stopped: if the latest seek made was
      // an exact one to `t` and nothing waits behind it, the element is there
      // or on its way, and a second would only decode the same frame again.
      // Remembered, not read back off the element: Chrome keeps the time a
      // seek landed on to the microsecond, not the double it was given, and
      // WebKit's currentTime reads the time a fastSeek was asked for.
      if (next == null && made && !made.approx && made.t === t) return;
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
      // A new source starts wherever it starts: nothing made before it holds.
      made = v && t != null ? { t, approx: false } : null;
      if (v && t != null) {
        try { v.currentTime = t; } catch { /* nothing more to try */ }
      }
      return t;
    },
    pending: () => wanted,
    onTarget,
    landed: (v) => wanted == null && next == null && onTarget(v),
    shown() { presented = true; },
    presented: () => presented,
  };
}
