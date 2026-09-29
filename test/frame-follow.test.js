// How often the player's label follows the frame on screen
// (lib/frame-follow.js), against the callbacks a browser makes: one per
// presented frame while playing, one per seek while paused, and a pause that
// lands between two paints.
//
// The player wires it as VideoPlayer.js does: requestVideoFrameCallback calls
// onFrame with the element's `paused`, the pause event calls settle(), and a
// step, a seek before load and a marker call set(); everything that acts on
// "this frame" reads frame().

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { frameFollower, LABEL_HZ } from '../lib/frame-follow.js';

/** A follower and every value it painted. */
function follower(opts) {
  const painted = [];
  const f = frameFollower((frame) => painted.push(frame), opts);
  return { f, painted };
}

/** A second of playback at `fps` on a clock starting at `t0` ms: onFrame for each frame. */
function play(f, fps, { t0 = 0, from = 0 } = {}) {
  const n = Math.round(fps);
  for (let i = 0; i < n; i++) f.onFrame(from + i, t0 + (i * 1000) / fps, false);
  return from + n - 1;
}

describe('while playing', () => {
  for (const fps of [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120]) {
    test(`${fps} fps: painted at most ${LABEL_HZ} times a second, and still moving`, () => {
      const { f, painted } = follower();
      const last = play(f, fps);
      assert.ok(painted.length <= LABEL_HZ, `${painted.length} paints`);
      assert.ok(painted.length >= 10, `${painted.length} paints: the label should still read as running`);
      assert.equal(f.frame(), last, 'the frame on screen is kept exactly, painted or not');
    });
  }

  test('at the common rates, the most the limit allows', () => {
    for (const fps of [30, 60]) {
      const { f, painted } = follower();
      play(f, fps);
      assert.equal(painted.length, LABEL_HZ, `${fps} fps`);
    }
  });

  test('a frame arriving a hair early is not held a frame longer', () => {
    const { f, painted } = follower();
    f.onFrame(0, 1000, false);
    f.onFrame(2, 1000 + 1000 / LABEL_HZ - 0.4, false);
    assert.deepEqual(painted, [0, 2]);
  });
});

describe('paused', () => {
  test('every frame presented is painted: a seek, a step, a scrub each show where they landed', () => {
    const { f, painted } = follower();
    for (const [i, frame] of [10, 11, 12, 40, 39].entries()) f.onFrame(frame, 5000 + i, true);
    assert.deepEqual(painted, [10, 11, 12, 40, 39]);
    assert.equal(f.frame(), 39);
  });

  test('a pause between paints lands the label on the frame playback stopped on', () => {
    const { f, painted } = follower();
    const last = play(f, 60);
    assert.notEqual(painted.at(-1), last, 'the last frames of the second were not painted');
    f.settle();
    assert.equal(painted.at(-1), last);
    assert.equal(f.frame(), last);
  });

  test('a frame presented as playback stops is painted at once', () => {
    const { f, painted } = follower();
    f.onFrame(100, 0, false);
    f.onFrame(101, 16, false);
    f.onFrame(102, 20, true);
    assert.deepEqual(painted, [100, 102]);
  });
});

describe('moved from outside', () => {
  test('set() is kept and painted at once, even mid-playback', () => {
    const { f, painted } = follower({ start: 0 });
    f.onFrame(0, 0, false);
    f.onFrame(1, 16, false);
    f.set(500);
    assert.deepEqual(painted, [0, 500]);
    assert.equal(f.frame(), 500);
  });

  test('a step reads the exact frame, not the last one painted', () => {
    const { f, painted } = follower();
    f.onFrame(0, 0, false);
    f.onFrame(1, 16, false);
    f.onFrame(2, 33, false);
    assert.deepEqual(painted, [0]);
    // What VideoPlayer's step(1) does: pause, then seek to the frame after this one.
    f.set(f.frame() + 1);
    assert.equal(f.frame(), 3);
  });

  test('the first frame is the one it was started on', () => {
    const { f, painted } = follower({ start: 42 });
    assert.equal(f.frame(), 42);
    assert.deepEqual(painted, []);
    f.settle();
    assert.deepEqual(painted, [42]);
  });
});
