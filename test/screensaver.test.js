// Tests for the screen saver's settings and the arithmetic its savers share
// (lib/screensaver.js): what a saved choice reads back as, which saver runs,
// the word clock's words, and the bounce and drift that keep a thing on
// screen inside its box.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  SAVERS, DELAYS, SPEEDS, SPEED_FACTOR, DEFAULT_PREF, MESSAGE_MAX, WORD_CLOCK_ROWS, WORD_CLOCK_COLS,
  saverFor, parseScreensaverPref, pickSaver, delayMs, clockParts, wordClock, bounce, drift,
} = await import('../lib/screensaver.js');

describe('the catalogue', () => {
  test('every saver has a unique key, a name, a group and a line about it', () => {
    const keys = new Set();
    for (const s of SAVERS) {
      assert.match(s.key, /^[a-z]+$/);
      assert.ok(!keys.has(s.key), `${s.key} twice`);
      keys.add(s.key);
      assert.ok(s.name && s.group && s.blurb, `${s.key} is missing a label`);
    }
    assert.ok(!keys.has('off'), 'off is the absence of one, not a saver');
    assert.ok(keys.has('shuffle'));
  });

  test('every speed has a factor, and normal is 1', () => {
    for (const s of SPEEDS) assert.ok(SPEED_FACTOR[s] > 0, s);
    assert.equal(SPEED_FACTOR.normal, 1);
    assert.ok(SPEED_FACTOR.slow < 1 && SPEED_FACTOR.fast > 1);
  });

  test('saverFor knows the catalogue and nothing else', () => {
    assert.equal(saverFor('clock').name, 'Clock');
    assert.equal(saverFor('off'), null);
    assert.equal(saverFor('flurry'), null);
  });
});

describe('parseScreensaverPref', () => {
  test('nothing saved, junk, and a string that is not JSON all read as the defaults', () => {
    for (const raw of [null, undefined, '', 'junk', '[]', 42, '{"saver":', { saver: 7 }]) {
      assert.deepEqual(parseScreensaverPref(raw), DEFAULT_PREF, String(raw));
    }
    assert.equal(DEFAULT_PREF.saver, 'off', 'nothing runs until someone picks one');
  });

  test('a saved choice round-trips, from JSON or an object', () => {
    const pref = { saver: 'photos', delay: 5, speed: 'fast', clock: true, drive: 'fs_1', message: 'Back soon' };
    assert.deepEqual(parseScreensaverPref(JSON.stringify(pref)), pref);
    assert.deepEqual(parseScreensaverPref(pref), pref);
  });

  test('a saver that no longer exists is off, not an error', () => {
    assert.equal(parseScreensaverPref({ saver: 'flurry' }).saver, 'off');
  });

  test('a delay that is not offered, a speed that is not, and a clock that is not a boolean fall to the defaults', () => {
    const p = parseScreensaverPref({ saver: 'clock', delay: 7, speed: 'ludicrous', clock: 'yes', drive: 12, message: 9 });
    assert.equal(p.delay, DEFAULT_PREF.delay);
    assert.equal(p.speed, 'normal');
    assert.equal(p.clock, false);
    assert.equal(p.drive, null);
    assert.equal(p.message, '');
  });

  test('a message is capped, and keeps the spaces someone is still typing', () => {
    assert.equal(parseScreensaverPref({ message: 'x'.repeat(500) }).message.length, MESSAGE_MAX);
    assert.equal(parseScreensaverPref({ message: 'Back ' }).message, 'Back ');
  });

  test('every offered delay is kept', () => {
    for (const d of DELAYS) assert.equal(parseScreensaverPref({ delay: d }).delay, d);
  });
});

describe('pickSaver and delayMs', () => {
  test('off runs nothing; a named saver runs itself', () => {
    assert.equal(pickSaver(null), null);
    assert.equal(pickSaver({ saver: 'off' }), null);
    assert.equal(pickSaver({ saver: 'stars' }), 'stars');
  });

  test('shuffle runs any other saver, never itself, and every one of them', () => {
    const seen = new Set();
    for (let i = 0; i < 400; i++) seen.add(pickSaver({ saver: 'shuffle' }, () => i / 400));
    assert.ok(!seen.has('shuffle'));
    assert.ok(!seen.has(null));
    assert.equal(seen.size, SAVERS.length - 1);
    assert.equal(pickSaver({ saver: 'shuffle' }, () => 0.999999), SAVERS.at(-2).key, 'a random just under 1 stays in range');
  });

  test('the delay is the minutes chosen', () => {
    assert.equal(delayMs({ delay: 5 }), 5 * 60_000);
    assert.equal(delayMs({ delay: 7 }), DEFAULT_PREF.delay * 60_000, 'one that is not offered is the default');
    assert.equal(delayMs(null), DEFAULT_PREF.delay * 60_000);
  });
});

describe('clockParts', () => {
  test('splits the period off a twelve-hour time and leaves a twenty-four-hour one whole', () => {
    const d = new Date(2026, 9, 15, 16, 7);
    assert.deepEqual(clockParts(d, 'en-US'), { time: '4:07', period: 'PM', date: 'Thursday, October 15' });
    const gb = clockParts(d, 'en-GB');
    assert.equal(gb.time, '16:07');
    assert.equal(gb.period, null);
    assert.equal(gb.date, 'Thursday 15 October');
  });
});

describe('the word clock', () => {
  test('the grid is eleven by ten', () => {
    assert.equal(WORD_CLOCK_ROWS.length, 10);
    for (const row of WORD_CLOCK_ROWS) assert.equal(row.length, WORD_CLOCK_COLS);
  });

  const says = (h, m) => wordClock(h, m).words.join(' ');

  test('says the time to the five minutes below, past and to', () => {
    assert.equal(says(16, 20), 'IT IS TWENTY PAST FOUR PM');
    assert.equal(says(4, 22), 'IT IS TWENTY PAST FOUR AM');
    assert.equal(says(10, 0), 'IT IS TEN OCLOCK AM');
    assert.equal(says(10, 4), 'IT IS TEN OCLOCK AM');
    assert.equal(says(9, 15), 'IT IS A QUARTER PAST NINE AM');
    assert.equal(says(9, 30), 'IT IS HALF PAST NINE AM');
    assert.equal(says(9, 35), 'IT IS TWENTY FIVE TO TEN AM');
    assert.equal(says(9, 45), 'IT IS A QUARTER TO TEN AM');
    assert.equal(says(23, 55), 'IT IS FIVE TO TWELVE PM');
    assert.equal(says(0, 5), 'IT IS FIVE PAST TWELVE AM');
    assert.equal(says(12, 50), 'IT IS TEN TO ONE PM');
  });

  test('every word it lights is a run of lit letters in the grid, and nothing else is lit', () => {
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += 5) {
        const { words, cells } = wordClock(h, m);
        const left = new Set(cells);
        // Longest first, so A does not take the A of AM.
        for (const word of [...words].sort((a, b) => b.length - a.length)) {
          // Somewhere in the grid the word is spelled by cells still lit.
          let found = false;
          for (let r = 0; r < WORD_CLOCK_ROWS.length && !found; r++) {
            for (let c = 0; c + word.length <= WORD_CLOCK_COLS && !found; c++) {
              const idx = Array.from({ length: word.length }, (_, i) => r * WORD_CLOCK_COLS + c + i);
              if (WORD_CLOCK_ROWS[r].slice(c, c + word.length) === word && idx.every((i) => left.has(i))) {
                for (const i of idx) left.delete(i);
                found = true;
              }
            }
          }
          assert.ok(found, `${h}:${m}: ${word} is not lit where it is spelled`);
        }
        assert.equal(left.size, 0, `${h}:${m}: letters lit that belong to no word`);
      }
    }
  });
});

describe('bounce', () => {
  const box = { width: 100, height: 50 };

  test('moves by its velocity and stays put when it meets nothing', () => {
    const s = bounce({ x: 10, y: 10, vx: 20, vy: -10, w: 10, h: 10 }, 0.5, box);
    assert.deepEqual([s.x, s.y, s.vx, s.vy, s.hit], [20, 5, 20, -10, false]);
  });

  test('turns back at each edge, reflected, and says so', () => {
    const right = bounce({ x: 88, y: 10, vx: 20, vy: 0, w: 10, h: 10 }, 0.5, box);
    assert.equal(right.x, 82);
    assert.equal(right.vx, -20);
    assert.ok(right.hit);
    const top = bounce({ x: 10, y: 2, vx: 0, vy: -20, w: 10, h: 10 }, 0.5, box);
    assert.equal(top.y, 8);
    assert.equal(top.vy, 20);
    assert.ok(top.hit);
  });

  test('never leaves the box, however long it runs or whatever the box', () => {
    for (const b of [box, { width: 1440, height: 900 }, { width: 200, height: 120 }]) {
      let s = { x: 0, y: 0, vx: 173, vy: -131, w: 60, h: 30 };
      for (let i = 0; i < 5000; i++) {
        s = bounce(s, 0.016, b);
        assert.ok(s.x >= 0 && s.x <= b.width - s.w, `x ${s.x} in ${b.width}`);
        assert.ok(s.y >= 0 && s.y <= b.height - s.h, `y ${s.y} in ${b.height}`);
      }
    }
  });

  test('a thing wider than its box is pinned, not thrown about', () => {
    const s = bounce({ x: 0, y: 0, vx: 50, vy: 50, w: 200, h: 100 }, 1, box);
    assert.deepEqual([s.x, s.y], [0, 0]);
  });
});

describe('drift', () => {
  test('keeps a thing inside its box at every moment, and moves it', () => {
    const box = { width: 1000, height: 600 };
    const size = { w: 300, h: 100 };
    const seen = new Set();
    for (let t = 0; t < 3600; t += 1) {
      const { x, y } = drift(t, box, size);
      assert.ok(x >= 0 && x <= 700 && y >= 0 && y <= 500, `${t}: ${x},${y}`);
      seen.add(`${Math.round(x / 50)},${Math.round(y / 50)}`);
    }
    assert.ok(seen.size > 30, 'over an hour it visits the whole screen');
  });

  test('a thing the size of its box stays at the origin', () => {
    assert.deepEqual(drift(123, { width: 100, height: 100 }, { w: 100, h: 100 }), { x: 0, y: 0 });
  });
});
