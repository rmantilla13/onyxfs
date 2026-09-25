// The player's arithmetic. Every case here is an off-by-one that presents as a
// UI glitch: a frame step that returns to the frame it left, a scrub that
// cannot reach the last pixel, a timecode reading 00:00:60:00.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  timecode, parseTimecode, stepFrame, timeFromPointer, percentOf,
  bufferedSpans, clampRange, shuttleRate, seekToDigit, ASSUMED_FPS, SHUTTLE_RATES,
} = await import('../lib/video-time.js');

describe('timecode', () => {
  test('zero and whole seconds', () => {
    assert.equal(timecode(0), '00:00:00:00');
    assert.equal(timecode(1), '00:00:01:00');
    assert.equal(timecode(83), '00:01:23:00');
    assert.equal(timecode(3725), '01:02:05:00');
  });

  test('frames are rounded, not floored', () => {
    // 1.9999s at 30fps is the last frame of second 1. Flooring holds the label
    // one frame behind the picture for the whole second, which reads as lag.
    assert.equal(timecode(1.9999, 30), '00:00:02:00');
    assert.equal(timecode(1.5, 30), '00:00:01:15');
  });

  test('a rounded frame never renders as frame == fps', () => {
    // THE bug this guards: round() can produce 30 at 30fps, and printing it
    // gives 00:00:01:30 — a frame number that does not exist. It must carry
    // into the next second instead.
    for (const fps of [24, 25, 30, 50, 60]) {
      for (const t of [0.999999, 1.999999, 59.999999, 3599.999999]) {
        const tc = timecode(t, fps);
        const frames = Number(tc.split(':')[3]);
        assert.ok(frames < fps, `${tc} at ${fps}fps has frame ${frames}`);
        assert.ok(Number(tc.split(':')[2]) < 60, `${tc} has a seconds field of 60`);
      }
    }
  });

  test('honours a real frame rate', () => {
    assert.equal(timecode(1.04, 25), '00:00:01:01');
    assert.equal(timecode(2 / 24, 24), '00:00:00:02');
  });

  test('nonsense is a zero timecode, not NaN on screen', () => {
    for (const bad of [undefined, null, NaN, -5, 'x', Infinity]) {
      assert.equal(timecode(bad), '00:00:00:00');
    }
  });

  test('an absent or absurd fps falls back rather than dividing by zero', () => {
    assert.equal(timecode(1.5, 0), timecode(1.5, ASSUMED_FPS));
    assert.equal(timecode(1.5, -1), timecode(1.5, ASSUMED_FPS));
  });
});

describe('parseTimecode', () => {
  test('clock forms', () => {
    assert.equal(parseTimecode('90'), 90);
    assert.equal(parseTimecode('1:30'), 90);
    assert.equal(parseTimecode('1:02:05'), 3725);
    assert.equal(parseTimecode('0:01.5'), 1.5);
  });

  test('four parts is HH:MM:SS:FF, and frames are frames', () => {
    // Read as clock time, frame 12 would become twelve seconds.
    assert.equal(parseTimecode('00:00:01:15', 30), 1.5);
    assert.equal(parseTimecode('00:01:23:00'), 83);
  });

  test('round trips with timecode', () => {
    for (const fps of [24, 30, 60]) {
      for (const t of [0, 1.5, 83.2, 3725.75]) {
        const back = parseTimecode(timecode(t, fps), fps);
        assert.ok(Math.abs(back - t) <= 1 / fps, `${t} -> ${timecode(t, fps)} -> ${back}`);
      }
    }
  });

  test('rejects rather than guessing', () => {
    for (const bad of ['', '  ', 'abc', '1:2:3:4:5', '1::2', '-1', 'x:y', null, undefined]) {
      assert.equal(parseTimecode(bad), null, JSON.stringify(bad));
    }
  });
});

describe('stepFrame', () => {
  test('forward and back from a frame boundary', () => {
    assert.ok(Math.abs(stepFrame(1, 1, { fps: 30 }) - 1 - 1 / 30) < 1e-9);
    assert.ok(Math.abs(stepFrame(1, -1, { fps: 30 }) - (1 - 1 / 30)) < 1e-9);
  });

  test('two steps out and two back return to the start', () => {
    // The reason it snaps to the grid first. Stepping by 1/fps from an
    // arbitrary currentTime lands mid-frame and never comes home.
    const fps = 30;
    let t = 1.517;                       // deliberately off-grid
    t = stepFrame(t, 1, { fps });
    t = stepFrame(t, 1, { fps });
    t = stepFrame(t, -1, { fps });
    t = stepFrame(t, -1, { fps });
    assert.ok(Math.abs(t - Math.round(1.517 * fps) / fps) < 1e-9, `landed at ${t}`);
  });

  test('never steps below zero or past the end', () => {
    assert.equal(stepFrame(0, -1, { fps: 30 }), 0);
    assert.equal(stepFrame(10, 1, { fps: 30, duration: 10 }), 10);
  });

  test('an unknown duration does not clamp to NaN', () => {
    assert.ok(stepFrame(5, 1, { fps: 30 }) > 5);
  });
});

describe('timeFromPointer', () => {
  const rect = { left: 100, width: 400 };

  test('maps across the bar', () => {
    assert.equal(timeFromPointer(100, rect, 60), 0);
    assert.equal(timeFromPointer(300, rect, 60), 30);
    assert.equal(timeFromPointer(500, rect, 60), 60);
  });

  test('a drag outside the bar is clamped, not extrapolated', () => {
    // Pointer capture keeps sending events past the edge; unclamped this
    // seeks negative or past the end.
    assert.equal(timeFromPointer(-50, rect, 60), 0);
    assert.equal(timeFromPointer(9999, rect, 60), 60);
  });

  test('a zero-width bar or unknown duration is 0, not NaN', () => {
    assert.equal(timeFromPointer(200, { left: 0, width: 0 }, 60), 0);
    assert.equal(timeFromPointer(200, rect, NaN), 0);
    assert.equal(timeFromPointer(200, rect, 0), 0);
  });
});

describe('percentOf and bufferedSpans', () => {
  test('percentages stay within 0..100', () => {
    assert.equal(percentOf(30, 60), 50);
    assert.equal(percentOf(-5, 60), 0);
    assert.equal(percentOf(120, 60), 100);
    assert.equal(percentOf(1, 0), 0);
  });

  test('reads a TimeRanges-shaped object', () => {
    const ranges = { length: 2, start: (i) => [0, 30][i], end: (i) => [10, 45][i] };
    const spans = bufferedSpans(ranges, 60);
    assert.equal(spans.length, 2);
    // Compared with tolerance: these are percentages painted into a style
    // attribute, and asserting exact float equality on them tests IEEE754
    // rather than the code.
    const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
    close(spans[0].left, 0); close(spans[0].width, 100 / 6);
    close(spans[1].left, 50); close(spans[1].width, 25);
  });

  test('reads a plain array too, so a test needs no fake TimeRanges', () => {
    assert.deepEqual(bufferedSpans([{ start: 0, end: 15 }], 60), [{ left: 0, width: 25 }]);
  });

  test('drops empty and inverted ranges instead of painting a negative width', () => {
    const ranges = [{ start: 10, end: 10 }, { start: 20, end: 5 }, { start: 0, end: NaN }];
    assert.deepEqual(bufferedSpans(ranges, 60), []);
  });

  test('no buffer and no duration are empty', () => {
    assert.deepEqual(bufferedSpans(null, 60), []);
    assert.deepEqual(bufferedSpans([{ start: 0, end: 5 }], 0), []);
  });
});

describe('clampRange', () => {
  test('keeps a sane range', () => {
    assert.deepEqual(clampRange({ inPoint: 5, outPoint: 20 }, 60), { inPoint: 5, outPoint: 20 });
  });

  test('a single end is allowed while the other is unset', () => {
    assert.deepEqual(clampRange({ inPoint: 5, outPoint: null }, 60), { inPoint: 5, outPoint: null });
    assert.deepEqual(clampRange({ inPoint: null, outPoint: 20 }, 60), { inPoint: null, outPoint: 20 });
  });

  test('out before in is nudged, not silently ignored', () => {
    // A zero-length or inverted range reads as a bug everywhere downstream:
    // a duration of 0, a loop that never advances, a link that ends at once.
    const r = clampRange({ inPoint: 20, outPoint: 5 }, 60);
    assert.ok(r.outPoint > r.inPoint, `${r.inPoint}..${r.outPoint}`);
  });

  test('both ends are clamped to the clip', () => {
    const r = clampRange({ inPoint: -10, outPoint: 999 }, 60);
    assert.deepEqual(r, { inPoint: 0, outPoint: 60 });
  });

  test('an in point at the very end still yields a usable range', () => {
    const r = clampRange({ inPoint: 60, outPoint: 60 }, 60);
    assert.ok(r.outPoint > r.inPoint);
    assert.ok(r.outPoint <= 60);
  });

  test('no duration means no range', () => {
    assert.deepEqual(clampRange({ inPoint: 1, outPoint: 2 }, 0), { inPoint: null, outPoint: null });
  });
});

describe('shuttle and digit seek', () => {
  test('rates escalate and then hold', () => {
    assert.equal(shuttleRate(1), 1);
    assert.equal(shuttleRate(3), 4);
    assert.equal(shuttleRate(99), SHUTTLE_RATES[SHUTTLE_RATES.length - 1]);
    assert.equal(shuttleRate(0), 1);
  });

  test('digits seek by tenths', () => {
    assert.equal(seekToDigit(0, 100), 0);
    assert.equal(seekToDigit(3, 100), 30);
    assert.equal(seekToDigit(9, 100), 90);
  });

  test('a non-digit or unknown duration is null, so the key does nothing', () => {
    for (const bad of [10, -1, 1.5, 'x', null]) assert.equal(seekToDigit(bad, 100), null);
    assert.equal(seekToDigit(5, 0), null);
  });
});
