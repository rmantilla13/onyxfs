// The player's arithmetic. Every case here is an off-by-one that presents as a
// UI glitch: a frame step that returns to the frame it left, a scrub that
// cannot reach the last pixel, a timecode reading 00:00:60:00.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  timecode, parseTimecode, stepFrame, timeFromPointer, percentOf,
  bufferedSpans, clampRange, shuttleRate, seekToDigit, ASSUMED_FPS, SHUTTLE_RATES,
  toRate, rateLabel, frameAt, secondsOfFrame, frameCount, clampFrame, canDropFrame, timecodeBase,
} = await import('../lib/video-time.js');

// Every rate the NLEs this is checked against produce, with the frame count of
// a 01:00:00:00 start in each. Drop-frame's hour is 108 frames short of the
// NDF one, which is the whole point of drop-frame: it keeps the label on the
// wall clock.
const RATES = [
  { name: '23.976', fps: { num: 24000, den: 1001 }, df: false, hour: 86400 },
  { name: '24', fps: { num: 24, den: 1 }, df: false, hour: 86400 },
  { name: '25', fps: { num: 25, den: 1 }, df: false, hour: 90000 },
  { name: '29.97 NDF', fps: { num: 30000, den: 1001 }, df: false, hour: 108000 },
  { name: '29.97 DF', fps: { num: 30000, den: 1001 }, df: true, hour: 107892 },
  { name: '30', fps: { num: 30, den: 1 }, df: false, hour: 108000 },
  { name: '50', fps: { num: 50, den: 1 }, df: false, hour: 180000 },
  { name: '59.94 DF', fps: { num: 60000, den: 1001 }, df: true, hour: 215784 },
  { name: '60', fps: { num: 60, den: 1 }, df: false, hour: 216000 },
];

describe('toRate', () => {
  test('keeps an exact rational, reduced', () => {
    assert.deepEqual(toRate({ num: 24000, den: 1001 }), { num: 24000, den: 1001 });
    assert.deepEqual(toRate({ num: 12800, den: 512 }), { num: 25, den: 1 });
    assert.deepEqual(toRate('30000/1001'), { num: 30000, den: 1001 });
  });

  test('a float or a 90 kHz approximation snaps to the rate it stands for', () => {
    // 90000/3754 is how some muxers store 23.976; left as it is, the label
    // drifts a frame every ten minutes against the NLE.
    assert.deepEqual(toRate(23.976), { num: 24000, den: 1001 });
    assert.deepEqual(toRate(29.97), { num: 30000, den: 1001 });
    assert.deepEqual(toRate(59.94), { num: 60000, den: 1001 });
    assert.deepEqual(toRate({ num: 90000, den: 3754 }), { num: 24000, den: 1001 });
  });

  test('never snaps 23.976 to 24, or 29.97 to 30', () => {
    assert.deepEqual(toRate(24), { num: 24, den: 1 });
    assert.deepEqual(toRate(30), { num: 30, den: 1 });
    assert.notDeepEqual(toRate({ num: 24000, den: 1001 }), toRate(24));
  });

  test('refuses what is not a rate', () => {
    for (const bad of [null, undefined, '', 0, -24, NaN, 'x', { num: 0, den: 1 }, { num: 24, den: 0 }, { num: 1.5, den: 1 }, 5000]) {
      assert.equal(toRate(bad), null, JSON.stringify(bad));
    }
  });

  test('labels', () => {
    assert.equal(rateLabel({ num: 24000, den: 1001 }), '23.976');
    assert.equal(rateLabel({ num: 30000, den: 1001 }), '29.97');
    assert.equal(rateLabel({ num: 25, den: 1 }), '25');
    assert.equal(rateLabel(null), '');
  });

  test('drop-frame exists only at 29.97 and 59.94', () => {
    assert.ok(canDropFrame({ num: 30000, den: 1001 }));
    assert.ok(canDropFrame({ num: 60000, den: 1001 }));
    for (const fps of [{ num: 24000, den: 1001 }, 24, 25, 30, 50, 60]) assert.equal(canDropFrame(fps), false);
    assert.equal(timecodeBase({ num: 24000, den: 1001 }), 24);
    assert.equal(timecodeBase({ num: 60000, den: 1001 }), 60);
  });
});

describe('frames and seconds', () => {
  for (const { name, fps } of RATES) {
    test(`${name}: every frame's start and middle read back as that frame`, () => {
      // The float product lands a hair under the integer often enough
      // (1001/24000 · 24000/1001) that a plain floor reads the frame before.
      for (let n = 0; n < 250000; n += 997) {
        const start = (n * fps.den) / fps.num;
        assert.equal(frameAt(start, fps), n, `start of ${n}`);
        assert.equal(frameAt(secondsOfFrame(n, fps), fps), n, `middle of ${n}`);
      }
    });
  }

  for (const { name, fps } of RATES) {
    test(`${name}: a timestamp rounded to the microsecond, as browsers report it, is still its frame`, () => {
      // THE browser case: Chrome's requestVideoFrameCallback gave frame 302
      // of a 29.97 clip as mediaTime 10.076733 — frame 301.99999 — and the
      // label read one frame early. Rounding either way must not move a frame.
      for (let n = 1; n < 400000; n += 373) {
        const exact = (n * fps.den) / fps.num;
        for (const t of [Math.round(exact * 1e6) / 1e6, Math.floor(exact * 1e6) / 1e6, Math.ceil(exact * 1e6) / 1e6]) {
          assert.equal(frameAt(t, fps), n, `${n} at ${t}`);
        }
      }
    });
  }

  test('the real mediaTime Chrome reported', () => {
    assert.equal(frameAt(10.076733, { num: 30000, den: 1001 }), 302);
  });

  test('a time just short of a boundary is still the frame before it', () => {
    // Only a start is snapped: 1% of a frame early is still the previous one.
    const fps = { num: 24000, den: 1001 };
    assert.equal(frameAt(((100 - 0.01) * 1001) / 24000, fps), 99);
  });

  test('seeks land mid-frame, not on the boundary browsers disagree about', () => {
    const fps = { num: 24000, den: 1001 };
    const t = secondsOfFrame(24, fps);
    assert.ok(t > (24 * 1001) / 24000 && t < (25 * 1001) / 24000);
    assert.ok(Math.abs(t - (24.5 * 1001) / 24000) < 1e-12);
  });

  test('nonsense time is frame 0', () => {
    for (const bad of [undefined, null, NaN, -5, 'x', -Infinity]) assert.equal(frameAt(bad, 30), 0);
  });

  test('frame count prefers the container, then the duration', () => {
    assert.equal(frameCount({ frames: 12, duration: 99, fps: 24 }), 12);
    assert.equal(frameCount({ duration: 10, fps: 30 }), 300);
    assert.equal(frameCount({ duration: 10, fps: { num: 30000, den: 1001 } }), 300);
    assert.equal(frameCount({}), Infinity);
    assert.equal(clampFrame(400, 300), 299);
    assert.equal(clampFrame(-3, 300), 0);
    assert.equal(clampFrame(12, Infinity), 12);
  });
});

describe('timecode', () => {
  test('zero and whole seconds at 30', () => {
    assert.equal(timecode(0, { fps: 30 }), '00:00:00:00');
    assert.equal(timecode(30, { fps: 30 }), '00:00:01:00');
    assert.equal(timecode(83 * 30, { fps: 30 }), '00:01:23:00');
    assert.equal(timecode(3725 * 30 + 15, { fps: 30 }), '01:02:05:15');
  });

  test('the frame field counts in the whole-number base', () => {
    // 23.976 counts 0..23 and 29.97 counts 0..29, whatever the real rate.
    assert.equal(timecode(23, { fps: { num: 24000, den: 1001 } }), '00:00:00:23');
    assert.equal(timecode(24, { fps: { num: 24000, den: 1001 } }), '00:00:01:00');
    assert.equal(timecode(1439, { fps: { num: 24000, den: 1001 } }), '00:00:59:23');
    assert.equal(timecode(49, { fps: 50 }), '00:00:00:49');
    assert.equal(timecode(59, { fps: 60 }), '00:00:00:59');
  });

  for (const { name, fps, df, hour } of RATES) {
    test(`${name}: a 01:00:00:00 start labels frame 0 as the hour`, () => {
      const sep = df ? ';' : ':';
      assert.equal(timecode(hour, { fps, dropFrame: df }), `01:00:00${sep}00`);
      assert.equal(timecode(0, { fps, tcStart: hour, dropFrame: df }), `01:00:00${sep}00`);
      assert.equal(timecode(timecodeBase(fps), { fps, tcStart: hour, dropFrame: df }), `01:00:01${sep}00`);
    });

    test(`${name}: labels round-trip through parseTimecode`, () => {
      const opts = { fps, dropFrame: df, tcStart: hour };
      for (let n = 0; n < 400000; n += 331) {
        const label = timecode(n, opts);
        assert.equal(parseTimecode(label, opts), n, `${n} -> ${label}`);
      }
    });

    test(`${name}: no field ever overflows`, () => {
      const base = timecodeBase(fps);
      for (let n = 0; n < 300000; n += 7) {
        const [h, m, s, f] = timecode(n, { fps, dropFrame: df }).split(/[:;]/).map(Number);
        assert.ok(h < 24 && m < 60 && s < 60 && f < base, `${n}`);
      }
    });
  }

  test('29.97 drop-frame skips ;00 and ;01 each minute but every tenth', () => {
    const fps = { num: 30000, den: 1001 };
    const o = { fps, dropFrame: true };
    assert.equal(timecode(1799, o), '00:00:59;29');
    assert.equal(timecode(1800, o), '00:01:00;02');
    assert.equal(timecode(3597, o), '00:01:59;29');
    assert.equal(timecode(3598, o), '00:02:00;02');
    assert.equal(timecode(17981, o), '00:09:59;29');
    assert.equal(timecode(17982, o), '00:10:00;00');
    assert.equal(timecode(17983, o), '00:10:00;01');
    // The same frames without drop-frame.
    assert.equal(timecode(1800, { fps }), '00:01:00:00');
    assert.equal(timecode(107892, { fps }), '00:59:56:12');
  });

  test('59.94 drop-frame skips four labels a minute', () => {
    const o = { fps: { num: 60000, den: 1001 }, dropFrame: true };
    assert.equal(timecode(3599, o), '00:00:59;59');
    assert.equal(timecode(3600, o), '00:01:00;04');
    assert.equal(timecode(35964, o), '00:10:00;00');
  });

  test('drop-frame keeps the label on the wall clock', () => {
    // An hour of 29.97 is 107892 frames. Its NDF label is 00:59:56:12, three
    // and a half seconds behind the clock; its DF label is the hour.
    const fps = { num: 30000, den: 1001 };
    const frame = parseTimecode('01:00:00;00', { fps });
    assert.equal(frame, 107892);
    assert.ok(Math.abs(secondsOfFrame(frame, fps) - 3600) < 1 / 29.97);
  });

  test('drop-frame is ignored for a rate that has none', () => {
    assert.equal(timecode(24, { fps: 24, dropFrame: true }), '00:00:01:00');
  });

  test('hours wrap at 24', () => {
    assert.equal(timecode(25 * 3600 * 25, { fps: 25 }), '01:00:00:00');
  });

  test('nonsense is a zero timecode, not NaN on screen', () => {
    for (const bad of [undefined, null, NaN, -5, 'x', Infinity]) {
      assert.equal(timecode(bad, { fps: 30 }), '00:00:00:00');
    }
    assert.equal(timecode(NaN, { fps: { num: 30000, den: 1001 }, dropFrame: true }), '00:00:00;00');
  });

  test('an absent or absurd rate falls back rather than dividing by zero', () => {
    assert.equal(timecode(45, { fps: 0 }), timecode(45, { fps: ASSUMED_FPS }));
    assert.equal(timecode(45, { fps: -1 }), timecode(45, { fps: ASSUMED_FPS }));
    assert.equal(timecode(45), '00:00:01:15');
  });
});

describe('parseTimecode', () => {
  test('clock forms are seconds into the clip', () => {
    assert.equal(parseTimecode('90', { fps: 30 }), 2700);
    assert.equal(parseTimecode('1:30', { fps: 30 }), 2700);
    assert.equal(parseTimecode('1:02:05', { fps: 30 }), 3725 * 30);
    assert.equal(parseTimecode('0:01.5', { fps: 30 }), 45);
    assert.equal(parseTimecode('0:01.5', { fps: 24 }), 36);
  });

  test('four parts is HH:MM:SS:FF, and frames are frames', () => {
    // Read as clock time, frame 12 would become twelve seconds.
    assert.equal(parseTimecode('00:00:01:15', { fps: 30 }), 45);
    assert.equal(parseTimecode('00:01:23:00', 30), 83 * 30);
  });

  test('a semicolon means drop-frame', () => {
    const fps = { num: 30000, den: 1001 };
    assert.equal(parseTimecode('00:01:00;02', { fps }), 1800);
    // A label drop-frame skips means the first that exists.
    assert.equal(parseTimecode('00:01:00;00', { fps }), 1800);
    assert.equal(parseTimecode('00:10:00;00', { fps }), 17982);
    // …and a colon on a drop-frame file is still its drop-frame label.
    assert.equal(parseTimecode('00:01:00:02', { fps, dropFrame: true }), 1800);
    assert.equal(parseTimecode('00:01:00:02', { fps }), 1802);
  });

  test('reads against the start timecode, and falls back to the clip start before it', () => {
    const opts = { fps: 24, tcStart: 86400 };
    assert.equal(parseTimecode('01:00:00:00', opts), 0);
    assert.equal(parseTimecode('01:00:12:04', opts), 12 * 24 + 4);
    // An old link from before start timecodes were known.
    assert.equal(parseTimecode('00:00:12:04', opts), 12 * 24 + 4);
  });

  test('rejects rather than guessing', () => {
    for (const bad of ['', '  ', 'abc', '1:2:3:4:5', '1::2', '-1', 'x:y', null, undefined,
      '00:00:01:30', '00:60:00:00', '00:00:61:00', '00:00:01.5:00', '1;30']) {
      assert.equal(parseTimecode(bad, { fps: 30 }), null, JSON.stringify(bad));
    }
  });
});

describe('stepFrame', () => {
  test('forward and back by exactly one frame, landing mid-frame', () => {
    const fps = 30;
    const t = secondsOfFrame(30, fps);
    assert.equal(frameAt(stepFrame(t, 1, { fps }), fps), 31);
    assert.equal(frameAt(stepFrame(t, -1, { fps }), fps), 29);
    assert.ok(Math.abs(stepFrame(t, 1, { fps }) - secondsOfFrame(31, fps)) < 1e-12);
  });

  test('two steps out and two back return to the start', () => {
    // Stepping by 1/fps from an arbitrary currentTime lands mid-frame at a
    // different offset each time and never comes home.
    const fps = { num: 24000, den: 1001 };
    let t = 1.517;                       // deliberately off-grid
    const start = frameAt(t, fps);
    t = stepFrame(t, 1, { fps });
    t = stepFrame(t, 1, { fps });
    t = stepFrame(t, -1, { fps });
    t = stepFrame(t, -1, { fps });
    assert.equal(frameAt(t, fps), start);
  });

  test('never steps below the first frame or past the last', () => {
    assert.equal(frameAt(stepFrame(0, -1, { fps: 30 }), 30), 0);
    const end = stepFrame(10, 1, { fps: 30, duration: 10 });
    assert.equal(frameAt(end, 30), 299);
    assert.ok(end <= 10);
    assert.equal(frameAt(stepFrame(secondsOfFrame(11, 24), 1, { fps: 24, frames: 12 }), 24), 11);
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
