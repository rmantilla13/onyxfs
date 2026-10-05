// Seeks asked of a <video> before its source has loaded, and whether its stage
// shows a frame yet (lib/pending-seek.js) — against a stand-in element that
// behaves as browsers do: a currentTime set at HAVE_NOTHING is kept as the
// "default playback start position" and sought to on load (Chrome), or
// dropped, or throws (older WebKit); a real seek fires `seeking`, which is
// what ends the poster.
//
// The player wires it as VideoPlayer.js does: every seek goes through
// seek(), loadedmetadata calls loaded(), seeking and play call shown(), and
// hold() loads the frame when presented() is false. On the scrub bar the press
// goes through seek(), each move after it through scrub(), a held drag that
// stops through rest() and letting go through release(); that part is tested
// against a stand-in that seeks as a loaded element does — busy until it
// fires `seeked`, a new seek overtaking the one in flight.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pendingSeek } from '../lib/pending-seek.js';
import { secondsOfFrame, frameAt, parseTimecode } from '../lib/video-time.js';

class FakeVideo {
  constructor({ early = 'keep' } = {}) {
    this.readyState = 0;
    this.early = early;        // 'keep' | 'drop' | 'throw': what a seek before load does
    this.defaultStart = 0;
    this.t = 0;
    this.seeks = [];
    this.onseeking = null;
  }
  get currentTime() { return this.t; }
  set currentTime(t) {
    if (this.readyState === 0) {
      if (this.early === 'throw') throw new Error('InvalidStateError');
      if (this.early === 'keep') this.defaultStart = t;
      return;
    }
    this.t = t;
    this.seeks.push(t);
    this.onseeking?.();
  }
  /** The metadata arrives: a browser that kept an early seek makes it now. */
  loadMetadata() {
    this.readyState = 1;
    if (this.defaultStart > 0) {
      this.t = this.defaultStart;
      this.seeks.push(this.defaultStart);
      this.onseeking?.();
    }
  }
}

/** The player's wiring, minus React. */
function player({ startAt = 0, early } = {}) {
  const v = new FakeVideo({ early });
  const intent = pendingSeek(startAt);
  v.onseeking = () => intent.shown();
  let frame = frameAt(intent.pending() ?? 0, FPS);
  const seekToFrame = (n) => { frame = n; intent.seek(v, secondsOfFrame(n, FPS)); };
  return {
    v,
    intent,
    frame: () => frame,
    seekToFrame,
    step: (dir) => seekToFrame(frame + dir),
    hold: () => { if (!intent.presented()) seekToFrame(frame); },
    load: () => { v.loadMetadata(); intent.loaded(v); frame = frameAt(v.currentTime, FPS); },
    play: () => intent.shown(),
  };
}

// The sandbox clip the reviewer used: 29.97 drop-frame, starting 01:00:00;00.
const FPS = { num: 30000, den: 1001 };
const MODEL = { fps: FPS, tcStart: 107892, dropFrame: true };
const deepLink = (tc) => secondsOfFrame(parseTimecode(tc, MODEL), FPS);

describe('a seek asked for before the source loads', () => {
  for (const early of ['keep', 'drop', 'throw']) {
    describe(`in a browser that ${early}s an early seek`, () => {
      test('a ?t= link alone opens on its frame', () => {
        const p = player({ startAt: deepLink('01:00:05;00'), early });
        assert.equal(p.frame(), 150, 'the label reads the link before anything loads');
        p.load();
        assert.equal(p.frame(), 150);
      });

      test('a marker clicked while loading lands on the marker, not the link', () => {
        const p = player({ startAt: deepLink('01:00:05;00'), early });
        const marker = parseTimecode('01:01:00;04', MODEL);
        p.seekToFrame(marker);
        p.load();
        assert.equal(p.frame(), marker);
        assert.equal(frameAt(p.v.currentTime, FPS), marker, 'the element is there, not only the label');
      });

      test('the first frame step after a link moves one frame', () => {
        const p = player({ startAt: deepLink('01:01:00;00'), early });
        assert.equal(p.frame(), 1800);
        p.step(1);
        p.step(1);
        p.load();
        assert.equal(p.frame(), 1802);
      });

      test('with no link and no request, loading seeks nowhere', () => {
        const p = player({ early });
        p.load();
        assert.deepEqual(p.v.seeks, []);
        assert.equal(p.intent.pending(), null);
      });
    });
  }

  test('a request is made once: a second load (a new source) does not replay it', () => {
    const p = player({ startAt: 10 });
    p.load();
    assert.equal(p.intent.loaded(p.v), null);
  });

  test('once loaded, a seek is made at once and nothing is kept', () => {
    const p = player();
    p.load();
    p.seekToFrame(300);
    assert.equal(frameAt(p.v.currentTime, FPS), 300);
    assert.equal(p.intent.pending(), null);
  });

  test('nonsense is not a request', () => {
    const intent = pendingSeek('soon');
    assert.equal(intent.pending(), null);
    const v = new FakeVideo();
    intent.seek(v, NaN);
    assert.equal(intent.pending(), null);
  });
});

describe('whether the stage shows a frame, or still the poster', () => {
  test('before load: the poster, so holding for a comment loads the label\'s frame', () => {
    // The reviewer's case: no ?t=, a master that waits for play, the poster
    // showing frame 224. C was pinned to frame 0 while 224 was on screen.
    const p = player();
    assert.equal(p.intent.presented(), false);
    p.hold();
    p.load();
    assert.equal(p.intent.presented(), true);
    assert.equal(p.frame(), 0);
    assert.equal(frameAt(p.v.currentTime, FPS), 0, 'frame 0 itself, sought to, so it replaces the poster');
  });

  test('loaded with no seek (a proxy, preload=metadata): still the poster', () => {
    const p = player();
    p.load();
    assert.equal(p.intent.presented(), false);
    p.hold();
    assert.equal(p.intent.presented(), true);
    assert.equal(p.v.seeks.length, 1);
  });

  test('after a seek or a play, holding only pauses', () => {
    const p = player({ startAt: 3 });
    p.load();
    assert.equal(p.intent.presented(), true, 'the link\'s seek ended the poster');
    const seeks = p.v.seeks.length;
    p.hold();
    assert.equal(p.v.seeks.length, seeks);

    const q = player();
    q.load();
    q.play();
    q.hold();
    assert.deepEqual(q.v.seeks, []);
  });
});

/**
 * A loaded element, as the scrub bar sees one: setting currentTime starts a
 * seek and `seeking` is true until land() fires `seeked`; a seek made while
 * one is in flight overtakes it, with one `seeked` for both. With `fast` it
 * has fastSeek, which lands on the keyframe at or before the time (one every
 * `gop` seconds), as Safari's and Firefox's approximate seeks do. `picture`
 * is the time of the frame on screen.
 *
 * With `webkit` it does as WebKit does (measured in a WKWebView, macOS 27, on
 * a clip with a keyframe every 20 s, by the frame number drawn into it):
 * after a fastSeek currentTime reads the time asked for, not the frame on
 * screen, and a seek to the time currentTime reads is no seek at all — it
 * fires `seeking` and `seeked`, the picture stays, and currentTime then reads
 * the picture's time.
 */
class SeekingVideo extends EventTarget {
  constructor({ fast = false, gop = 2, readyState = 1, webkit = false } = {}) {
    super();
    this.readyState = readyState;
    this.webkit = webkit;
    this.seeking = false;
    this.t = 0;
    this.picture = 0;
    this.writes = [];      // currentTime set: an exact seek, a decode to the frame
    this.fastSeeks = [];   // fastSeek called
    if (fast) {
      this.fastSeek = (t) => {
        this.fastSeeks.push(t);
        const key = Math.floor(t / gop) * gop;
        if (this.readyState > 0) this.begin(webkit ? t : key, key);
      };
    }
  }
  get currentTime() { return this.t; }
  set currentTime(t) {
    this.writes.push(t);
    if (this.readyState === 0) return;
    if (this.webkit && !this.seeking && t === this.t) this.begin(t, this.picture, true);
    else this.begin(t, t);
  }
  begin(reads, shows, reread = false) {
    this.t = reads;
    this.shows = shows;
    this.reread = reread;
    this.seeking = true;
  }
  /** The seek in flight is done. False when there was none. */
  land() {
    if (!this.seeking) return false;
    this.seeking = false;
    this.picture = this.shows;
    if (this.reread) this.t = this.picture;
    // Chrome keeps where a seek landed to the microsecond (a TimeDelta),
    // not the double it was given.
    this.t = Math.round(this.t * 1e6) / 1e6;
    this.dispatchEvent(new Event('seeked'));
    return true;
  }
  /** Lands until nothing is left in flight. Returns how many seeks that took. */
  settle() {
    let n = 0;
    while (this.land()) n += 1;
    return n;
  }
}

/** Twenty pointer moves along the bar, a quarter-second apart in the clip. */
const BURST = Array.from({ length: 20 }, (_, i) => 3 + i * 0.25);

describe('a drag along the scrub bar', () => {
  test('a burst of twenty moves makes two seeks, and ends on the last', () => {
    // Chrome has no fastSeek: every seek a drag makes is an exact one, a
    // range request and a decode into a long-GOP original.
    const v = new SeekingVideo();
    const intent = pendingSeek();
    for (const t of BURST) intent.scrub(v, t);
    assert.deepEqual(v.writes, [BURST[0]], 'one in flight; the other nineteen wait, and only the last is kept');
    assert.equal(intent.landed(v), false);
    v.settle();
    assert.ok(v.writes.length <= 2, `${v.writes.length} seeks`);
    assert.equal(v.currentTime, BURST.at(-1));
    assert.equal(intent.landed(v), true);
  });

  test('a long drag makes one seek per landing, not one per move', () => {
    const v = new SeekingVideo();
    const intent = pendingSeek();
    const moves = Array.from({ length: 60 }, (_, i) => i * 0.5);
    moves.forEach((t, i) => {
      intent.scrub(v, t);
      // The element is slow: it lands once for every ten moves.
      if (i % 10 === 9) v.land();
    });
    v.settle();
    assert.ok(v.writes.length <= 7, `${v.writes.length} seeks for ${moves.length} moves`);
    assert.equal(v.currentTime, moves.at(-1));
    // Each landing went to the latest move, never one it had already passed.
    assert.deepEqual(v.writes, [...v.writes].sort((a, b) => a - b));
  });

  test('where the browser has fastSeek, a drag uses it and sets no exact time', () => {
    const v = new SeekingVideo({ fast: true });
    const intent = pendingSeek();
    for (const t of BURST) intent.scrub(v, t);
    v.settle();
    assert.deepEqual(v.writes, []);
    assert.deepEqual(v.fastSeeks, [BURST[0], BURST.at(-1)]);
    assert.equal(v.currentTime, 6, 'on the keyframe before 7.75, not the frame');
  });

  test('letting go lands exactly where the pointer was', () => {
    const v = new SeekingVideo({ fast: true });
    const intent = pendingSeek();
    for (const t of BURST) intent.scrub(v, t);
    v.settle();
    intent.release(v, 7.75);
    v.settle();
    assert.deepEqual(v.writes, [7.75], 'an exact seek after the approximate ones');
    assert.equal(v.currentTime, 7.75);
    assert.equal(intent.landed(v), true);
  });

  test('letting go mid-flight with fastSeek: exact, though currentTime reads the drag\'s target', () => {
    // Safari's currentTime is the time asked for while a seek is out, not the
    // keyframe the approximate one will land on.
    const v = new SeekingVideo({ fast: true, webkit: true });
    const intent = pendingSeek();
    intent.scrub(v, 7.75);
    intent.release(v, 7.75);
    v.settle();
    assert.equal(v.writes.length, 1);
    assert.equal(frameAt(v.picture, FPS), frameAt(7.75, FPS));
  });

  test('letting go where the last exact seek went makes no second one', () => {
    const v = new SeekingVideo();
    const intent = pendingSeek();
    // A click on the bar: down and up at the same place.
    intent.scrub(v, 12);
    intent.release(v, 12);
    v.settle();
    assert.deepEqual(v.writes, [12], 'one decode for one click');
    // A drag that rested before letting go: the last move has already landed.
    for (const t of BURST) intent.scrub(v, t);
    v.settle();
    intent.release(v, BURST.at(-1));
    assert.deepEqual(v.writes, [12, BURST[0], BURST.at(-1)]);
    assert.equal(intent.landed(v), true);
    // Let go a pixel on from the last move: that is a seek of its own.
    intent.release(v, 8);
    v.settle();
    assert.equal(v.currentTime, 8);
  });

  test('a drag that landed on a time kept to the microsecond is still where it was let go', () => {
    // A pointer's time is any double: 0.6327 of a 19.986633 s bar.
    const t = 0.6327 * 19.986633;
    const v = new SeekingVideo();
    const intent = pendingSeek();
    intent.scrub(v, t);
    v.settle();
    assert.notEqual(v.currentTime, t, 'the element reads it back rounded');
    intent.release(v, t);
    assert.deepEqual(v.writes, [t]);
  });

  test('letting go mid-flight: the drag\'s waiting target is never made after it', () => {
    for (const fast of [false, true]) {
      const v = new SeekingVideo({ fast });
      const intent = pendingSeek();
      for (const t of BURST) intent.scrub(v, t);   // one in flight, the last kept
      intent.release(v, 5.5);                     // let go at 5.5: overtakes it
      v.settle();
      assert.equal(v.currentTime, 5.5, fast ? 'with fastSeek' : 'without');
      assert.equal(v.writes.at(-1), 5.5);
      assert.ok(!v.writes.includes(BURST.at(-1)) && !v.fastSeeks.includes(BURST.at(-1)));
    }
  });

  test('letting go where a waiting target was going: made now, exactly, once', () => {
    const v = new SeekingVideo();
    const intent = pendingSeek();
    for (const t of BURST) intent.scrub(v, t);
    intent.release(v, BURST.at(-1));
    v.settle();
    assert.deepEqual(v.writes, [BURST[0], BURST.at(-1)]);
    assert.equal(v.currentTime, BURST.at(-1));
  });

  test('a key, a frame step or a marker is exact and goes at once, even mid-drag', () => {
    const v = new SeekingVideo({ fast: true });
    const intent = pendingSeek();
    intent.scrub(v, 9);
    const f = 300;
    intent.seek(v, secondsOfFrame(f, FPS));
    assert.equal(frameAt(v.currentTime, FPS), f, 'made now, not after the drag\'s seek lands');
    intent.seek(v, secondsOfFrame(f + 1, FPS));
    assert.equal(v.writes.length, 2, 'one exact seek per step: none is skipped');
    v.settle();
    assert.equal(frameAt(v.currentTime, FPS), f + 1);
  });

  test('a seek cut short with no `seeked` (a new source) does not hold the drag up', () => {
    const v = new SeekingVideo();
    const intent = pendingSeek();
    intent.scrub(v, 1);
    intent.scrub(v, 2);
    v.seeking = false;   // the proxy arrived: the element reloaded, no `seeked`
    intent.scrub(v, 3);
    assert.deepEqual(v.writes, [1, 3]);
    v.settle();
    assert.equal(v.currentTime, 3);
    assert.equal(v.writes.length, 2, 'the target the lost seek was holding is dropped, not made late');
  });

  test('a click is one exact seek, with fastSeek or without', () => {
    // The player's wiring: the press is seek(), letting go release().
    for (const fast of [false, true]) {
      const v = new SeekingVideo({ fast });
      const intent = pendingSeek();
      intent.seek(v, 12);
      intent.release(v, 12);
      v.settle();
      assert.deepEqual(v.writes, [12], fast ? 'with fastSeek' : 'without');
      assert.deepEqual(v.fastSeeks ?? [], [], 'no approximate seek to flash a keyframe first');
      assert.equal(intent.landed(v), true);
    }
  });

  test('a press and a drag: exact, then approximate, then exact where it is let go', () => {
    const v = new SeekingVideo({ fast: true });
    const intent = pendingSeek();
    intent.seek(v, BURST[0]);
    for (const t of BURST.slice(1)) intent.scrub(v, t);
    v.settle();
    assert.deepEqual(v.writes, [BURST[0]]);
    assert.deepEqual(v.fastSeeks, [BURST.at(-1)], 'the moves waited for the press, and only the last was made');
    intent.release(v, BURST.at(-1));
    v.settle();
    assert.deepEqual(v.writes, [BURST[0], BURST.at(-1)]);
    assert.equal(v.currentTime, BURST.at(-1));
  });

  // A long-GOP original: a 600-frame GOP at 30 fps is a keyframe every 20 s.
  const LONG_GOP = 20;

  test('a keyframe short of where the drag asked has not landed there', () => {
    for (const webkit of [false, true]) {
      const v = new SeekingVideo({ fast: true, gop: LONG_GOP, webkit });
      const intent = pendingSeek();
      intent.scrub(v, 37);
      v.settle();
      assert.equal(v.picture, 20, 'the keyframe, 17 s short of the pointer');
      assert.equal(v.currentTime, webkit ? 37 : 20, 'what the element says');
      assert.equal(intent.onTarget(v), false);
      assert.equal(intent.landed(v), false, webkit ? 'in WebKit' : 'elsewhere');
      intent.release(v, 37);
      assert.equal(intent.landed(v), false, 'letting go: in flight');
      v.settle();
      assert.equal(frameAt(v.picture, FPS), frameAt(37, FPS));
      assert.equal(intent.landed(v), true, 'the exact seek put the frame on screen');
    }
  });

  test('in WebKit, letting go where the last move went shows that frame, not its keyframe', () => {
    // WebKit reads currentTime as 37 once the fastSeek is done, and makes no
    // seek to 37: the keyframe stayed, and the label read 20.
    const v = new SeekingVideo({ fast: true, gop: LONG_GOP, webkit: true });
    const intent = pendingSeek();
    intent.seek(v, 21);
    v.settle();
    for (const t of [26, 31, 37]) { intent.scrub(v, t); v.settle(); }
    assert.equal(v.picture, 20);
    intent.release(v, 37);
    v.settle();
    assert.equal(frameAt(v.picture, FPS), frameAt(37, FPS), 'the frame let go on');
    assert.ok(Math.abs(v.writes.at(-1) - 37) <= 1e-6, 'a microsecond on at most');
    assert.equal(intent.landed(v), true);
  });

  test('a drag that stops, still held, is sought exactly there, once; letting go there makes no other', () => {
    for (const webkit of [false, true]) {
      const v = new SeekingVideo({ fast: true, gop: LONG_GOP, webkit });
      const intent = pendingSeek();
      for (const t of [21, 26, 31, 39]) intent.scrub(v, t);
      v.settle();
      assert.equal(v.picture, 20, 'resting on a keyframe 19 s short');
      intent.rest(v, 39);
      v.settle();
      assert.equal(v.writes.length, 1);
      assert.equal(frameAt(v.picture, FPS), frameAt(39, FPS), 'the frame it stopped on');
      assert.equal(intent.landed(v), true);
      intent.rest(v, 39);
      intent.release(v, 39);
      v.settle();
      assert.equal(v.writes.length, 1, 'one exact seek for the rest and the release');
    }
  });

  test('a drag that stops while its latest is still waiting: that one is made exactly, now', () => {
    const v = new SeekingVideo({ fast: true, gop: LONG_GOP });
    const intent = pendingSeek();
    for (const t of BURST) intent.scrub(v, t);     // one in flight, the last kept
    intent.rest(v, BURST.at(-1));
    v.settle();
    assert.deepEqual(v.fastSeeks, [BURST[0]], 'the kept target is never made approximately');
    assert.deepEqual(v.writes, [BURST.at(-1)]);
    assert.equal(v.picture, BURST.at(-1));
    assert.equal(intent.landed(v), true);
  });

  test('without fastSeek a drag that stops makes nothing more: its own seeks are exact', () => {
    const v = new SeekingVideo();
    const intent = pendingSeek();
    for (const t of BURST) intent.scrub(v, t);
    intent.rest(v, BURST.at(-1));
    assert.deepEqual(v.writes, [BURST[0]], 'the kept target waits for `seeked`, as before');
    v.settle();
    intent.rest(v, BURST.at(-1));
    assert.deepEqual(v.writes, [BURST[0], BURST.at(-1)]);
  });

  test('what `seeked` hears: an exact landing is on target, an approximate one is not', () => {
    for (const fast of [false, true]) {
      const v = new SeekingVideo({ fast, gop: LONG_GOP, webkit: fast });
      const intent = pendingSeek();
      // The player's onSeeked: React adds its listener when the element is
      // made, so it hears `seeked` before pending-seek makes the next seek.
      const heard = [];
      v.addEventListener('seeked', () => heard.push([intent.onTarget(v), intent.landed(v)]));
      intent.scrub(v, 9);
      intent.scrub(v, 30);            // kept behind the one in flight
      v.settle();
      intent.release(v, 30);
      v.settle();
      assert.deepEqual(heard, fast
        ? [[false, false], [false, false], [true, true]]   // 0, 20, then 30 exactly
        : [[true, false], [true, true]]);                  // 9 with 30 to come, then 30
    }
  });

  test('before the source loads, a drag keeps its latest for load, and letting go its own', () => {
    const v = new SeekingVideo({ fast: true, readyState: 0 });
    const intent = pendingSeek(deepLink('01:00:05;00'));
    for (const t of BURST) intent.scrub(v, t);
    assert.equal(intent.pending(), BURST.at(-1));
    assert.deepEqual(v.fastSeeks, [], 'fastSeek does nothing before metadata; the time is set instead');
    intent.release(v, 4.25);
    v.readyState = 1;
    assert.equal(intent.loaded(v), 4.25);
    assert.equal(intent.landed(v), false, 'the load\'s seek is in flight');
    v.settle();
    assert.equal(v.currentTime, 4.25);
    assert.equal(intent.landed(v), true);
  });
});
