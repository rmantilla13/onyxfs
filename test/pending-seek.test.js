// Seeks asked of a <video> before its source has loaded, and whether its stage
// shows a frame yet (lib/pending-seek.js) — against a stand-in element that
// behaves as browsers do: a currentTime set at HAVE_NOTHING is kept as the
// "default playback start position" and sought to on load (Chrome), or
// dropped, or throws (older WebKit); a real seek fires `seeking`, which is
// what ends the poster.
//
// The player wires it as VideoPlayer.js does: every seek goes through
// seek(), loadedmetadata calls loaded(), seeking and play call shown(), and
// hold() loads the frame when presented() is false.

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
