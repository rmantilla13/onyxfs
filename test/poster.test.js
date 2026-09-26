// Poster sizes and poster frames. Every failure here is visual and silent: a
// soft grid, a blurry player, a black tile, or a library that remakes the
// same thumbnail on every visit.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  gridPosterSize, playerPosterSize, playerPosterFor, isUndersizedPoster, downscalePlan,
  posterTimes, frameStats, isBlankFrame, chooseFrame,
  GRID_POSTER_BOX, GRID_POSTER_MAX_EDGE, PLAYER_POSTER_MAX_EDGE, LEGACY_THUMB_MAX, MAX_INTERMEDIATE_EDGE,
} from '../lib/poster.js';

// The widest a grid card gets, in CSS px (two columns just under the 720px
// breakpoint), and the 4:3 box it shows a poster in.
const WIDEST_CARD = 340;

describe('gridPosterSize', () => {
  test('a 16:9 clip is 1024x576 — its short edge fills the 4:3 card', () => {
    assert.deepEqual(gridPosterSize({ width: 1920, height: 1080 }), { width: 1024, height: 576 });
    assert.deepEqual(gridPosterSize({ width: 3840, height: 2160 }), { width: 1024, height: 576 });
  });

  test('a portrait photo keeps the card width covered', () => {
    assert.deepEqual(gridPosterSize({ width: 3024, height: 4032 }), { width: 768, height: 1024 });
    assert.deepEqual(gridPosterSize({ width: 1080, height: 1920 }), { width: 768, height: 1365 });
  });

  test('covers the widest card on a 2x screen, whatever the shape', () => {
    const need = { width: WIDEST_CARD * 2, height: WIDEST_CARD * 0.75 * 2 };
    for (const [w, h] of [[1920, 1080], [4096, 2160], [4032, 3024], [3024, 4032], [1080, 1920], [2000, 2000], [2560, 1080]]) {
      const s = gridPosterSize({ width: w, height: h });
      // object-fit: cover scales by the larger ratio; at or under 1 is no enlargement.
      const scale = Math.max(need.width / s.width, need.height / s.height);
      assert.ok(scale <= 1, `${w}x${h} → ${s.width}x${s.height} is enlarged ${scale.toFixed(2)}x`);
    }
  });

  test('never enlarges a small source', () => {
    assert.deepEqual(gridPosterSize({ width: 640, height: 480 }), { width: 640, height: 480 });
    assert.deepEqual(gridPosterSize({ width: 64, height: 64 }), { width: 64, height: 64 });
  });

  test('a panorama stops at the long-edge cap', () => {
    const s = gridPosterSize({ width: 12000, height: 2000 });
    assert.equal(s.width, GRID_POSTER_MAX_EDGE);
    assert.equal(s.height, Math.round(2000 * GRID_POSTER_MAX_EDGE / 12000));
  });

  test('no usable dimensions, no size', () => {
    for (const bad of [null, {}, { width: 0, height: 10 }, { width: 'x', height: 10 }, { width: -5, height: 5 }]) {
      assert.equal(gridPosterSize(bad), null);
    }
  });

  test('the box is the card shape at 2x', () => {
    assert.equal(GRID_POSTER_BOX.width / GRID_POSTER_BOX.height, 4 / 3);
    assert.ok(GRID_POSTER_BOX.width >= WIDEST_CARD * 2);
  });
});

describe('playerPosterSize', () => {
  test('1920 on the long edge, either way up', () => {
    assert.deepEqual(playerPosterSize({ width: 3840, height: 2160 }), { width: 1920, height: 1080 });
    assert.deepEqual(playerPosterSize({ width: 2160, height: 3840 }), { width: 1080, height: 1920 });
    assert.equal(Math.max(...Object.values(playerPosterSize({ width: 4096, height: 2160 }))), PLAYER_POSTER_MAX_EDGE);
  });

  test('never enlarged', () => {
    assert.deepEqual(playerPosterSize({ width: 1280, height: 720 }), { width: 1280, height: 720 });
  });

  test('only made when it is materially bigger than the grid poster', () => {
    assert.deepEqual(playerPosterFor({ width: 3840, height: 2160 }), { width: 1920, height: 1080 });
    assert.deepEqual(playerPosterFor({ width: 1920, height: 1080 }), { width: 1920, height: 1080 });
    assert.deepEqual(playerPosterFor({ width: 1280, height: 720 }), { width: 1280, height: 720 });
    assert.deepEqual(playerPosterFor({ width: 1080, height: 1920 }), { width: 1080, height: 1920 });
    // Its grid poster is the whole frame already: a second copy buys nothing.
    assert.equal(playerPosterFor({ width: 640, height: 360 }), null);
    assert.equal(playerPosterFor({ width: 800, height: 450 }), null);
    assert.equal(playerPosterFor(null), null);
  });

  test('about one pixel per device pixel on the widest stage at 2x', () => {
    // 1400px shell − 2×24 padding − 360px inspector − 24px gap.
    const stage = 1400 - 48 - 360 - 24;
    assert.ok(playerPosterSize({ width: 3840, height: 2160 }).width >= stage * 2 * 0.98);
  });
});

describe('isUndersizedPoster', () => {
  test('every old 480px thumbnail of a larger source is undersized', () => {
    assert.ok(isUndersizedPoster({ width: 480, height: 270 }, { width: 1920, height: 1080 }));
    assert.ok(isUndersizedPoster({ width: 480, height: 253 }, { width: 4096, height: 2160 }));
    assert.ok(isUndersizedPoster({ width: 360, height: 480 }, { width: 3024, height: 4032 }));
    assert.ok(isUndersizedPoster({ width: 270, height: 480 }, { width: 1080, height: 1920 }));
  });

  test('what gridPosterSize makes today is not — nor a pixel off it', () => {
    for (const src of [{ width: 1920, height: 1080 }, { width: 3024, height: 4032 }, { width: 12000, height: 2000 }]) {
      const made = gridPosterSize(src);
      assert.ok(!isUndersizedPoster(made, src), JSON.stringify(src));
      assert.ok(!isUndersizedPoster({ width: made.width - 1, height: made.height - 1 }, src));
    }
  });

  test('a source too small to do better is left alone, so it is not remade on every visit', () => {
    assert.ok(!isUndersizedPoster({ width: 400, height: 300 }, { width: 400, height: 300 }));
    // An old thumbnail of a source only a little over the old cap: close enough.
    assert.ok(!isUndersizedPoster({ width: 480, height: 384 }, { width: 500, height: 400 }));
  });

  test('with no source dimensions on record, only a thumbnail within the old cap is suspect', () => {
    assert.ok(isUndersizedPoster({ width: LEGACY_THUMB_MAX, height: 270 }, {}));
    assert.ok(isUndersizedPoster({ width: 200, height: 150 }, null));
    assert.ok(!isUndersizedPoster({ width: 1024, height: 576 }, {}));
  });

  test('an image that has not decoded is never judged', () => {
    assert.ok(!isUndersizedPoster({ width: 0, height: 0 }, { width: 1920, height: 1080 }));
    assert.ok(!isUndersizedPoster(null, { width: 1920, height: 1080 }));
  });
});

describe('downscalePlan', () => {
  test('halves until within 2x, then lands on the target', () => {
    assert.deepEqual(downscalePlan({ width: 4096, height: 2160 }, { width: 1024, height: 540 }),
      [{ width: 2048, height: 1080 }, { width: 1024, height: 540 }]);
    assert.deepEqual(downscalePlan({ width: 7680, height: 4320 }, { width: 1024, height: 576 }),
      [{ width: 3840, height: 2160 }, { width: 1920, height: 1080 }, { width: 1024, height: 576 }]);
  });

  test('no step shrinks by more than 2x', () => {
    for (const [from, to] of [
      [{ width: 6000, height: 4000 }, { width: 864, height: 576 }],
      [{ width: 4032, height: 3024 }, { width: 768, height: 576 }],
      [{ width: 1080, height: 1920 }, { width: 768, height: 1365 }],
      [{ width: 7680, height: 4320 }, { width: 1920, height: 1080 }],
    ]) {
      const plan = downscalePlan(from, to);
      let prev = from;
      for (const step of plan) {
        assert.ok(prev.width / step.width <= 2 && prev.height / step.height <= 2,
          `${prev.width}x${prev.height} → ${step.width}x${step.height}`);
        prev = step;
      }
      assert.deepEqual(plan[plan.length - 1], to);
    }
  });

  test('no intermediate is bigger than a phone will make a canvas', () => {
    // A 108-megapixel photo halved is still 27 megapixels, past iOS Safari's
    // canvas limit. It takes one larger first step, then halves as usual.
    const plan = downscalePlan({ width: 12000, height: 9000 }, { width: 768, height: 576 });
    assert.deepEqual(plan, [{ width: 3000, height: 2250 }, { width: 1500, height: 1125 }, { width: 768, height: 576 }]);
    for (const [from, to] of [
      [{ width: 12000, height: 9000 }, { width: 768, height: 576 }],
      [{ width: 12000, height: 2000 }, { width: 2048, height: 341 }],
      [{ width: 20000, height: 20000 }, { width: 768, height: 768 }],
    ]) {
      const p = downscalePlan(from, to);
      for (const step of p) assert.ok(Math.max(step.width, step.height) <= MAX_INTERMEDIATE_EDGE, JSON.stringify(step));
      for (let i = 1; i < p.length; i++) assert.ok(p[i - 1].width / p[i].width <= 2, 'after the first step, still halving');
      assert.deepEqual(p[p.length - 1], to);
    }
  });

  test('a small reduction is one draw', () => {
    assert.deepEqual(downscalePlan({ width: 1920, height: 1080 }, { width: 1024, height: 576 }), [{ width: 1024, height: 576 }]);
    assert.deepEqual(downscalePlan({ width: 640, height: 480 }, { width: 640, height: 480 }), [{ width: 640, height: 480 }]);
  });

  test('nothing to plan without dimensions', () => {
    assert.deepEqual(downscalePlan(null, { width: 10, height: 10 }), []);
  });
});

describe('posterTimes', () => {
  test('a tenth in first, then a quarter and halfway', () => {
    assert.deepEqual(posterTimes(20), [2, 5, 10]);
    assert.deepEqual(posterTimes(3600), [360, 900, 1800]);
  });

  test('at least a second in — the opening frame is so often black', () => {
    assert.equal(posterTimes(8)[0], 1);
    assert.deepEqual(posterTimes(12), [1.2, 3, 6]);
  });

  test('never past the middle, and only increasing', () => {
    for (const d of [0.4, 1, 1.5, 2, 3, 5, 9.9, 60, 7200]) {
      const t = posterTimes(d);
      assert.ok(t.length >= 1);
      t.forEach((x, i) => {
        assert.ok(x > 0 && x <= d / 2 + 1e-9, `${d}s: ${x}`);
        if (i) assert.ok(x > t[i - 1], `${d}s: ${t}`);
      });
    }
  });

  test('a clip too short for more than one try gets one', () => {
    assert.deepEqual(posterTimes(2), [1]);
    assert.deepEqual(posterTimes(0.5), [0.25]);
  });

  test('unknown length: just past the start', () => {
    for (const d of [0, NaN, Infinity, undefined, -3]) assert.deepEqual(posterTimes(d), [0.1]);
  });
});

function pixels(values) {
  const out = new Uint8ClampedArray(values.length * 4);
  values.forEach((v, i) => { out.set([v, v, v, 255], i * 4); });
  return out;
}

describe('frame selection', () => {
  test('frameStats reads mean and spread of luma', () => {
    assert.deepEqual(frameStats(pixels([0, 0, 0, 0])), { mean: 0, spread: 0 });
    const s = frameStats(pixels([0, 255, 0, 255]));
    assert.ok(Math.abs(s.mean - 127.5) < 0.01);
    assert.ok(Math.abs(s.spread - 127.5) < 0.01);
    assert.deepEqual(frameStats(new Uint8ClampedArray(0)), { mean: 0, spread: 0 });
  });

  test('black, white and flat frames are blank; a dark but detailed one is not', () => {
    assert.ok(isBlankFrame(frameStats(pixels(Array(64).fill(3)))));        // black leader
    assert.ok(isBlankFrame(frameStats(pixels(Array(64).fill(252)))));      // white flash
    assert.ok(isBlankFrame(frameStats(pixels(Array(64).fill(120)))));      // flat grey slate
    const night = Array.from({ length: 64 }, (_, i) => (i % 8 === 0 ? 180 : 15));
    assert.ok(!isBlankFrame(frameStats(pixels(night))));                   // city lights
    assert.ok(!isBlankFrame({ mean: 110, spread: 50 }));
    assert.ok(!isBlankFrame(null), 'no reading is not a reason to reject a frame');
  });

  test('chooseFrame takes the first real picture, else the least blank', () => {
    const black = { mean: 2, spread: 1 };
    const fade = { mean: 9, spread: 4 };
    const picture = { mean: 110, spread: 50 };
    assert.equal(chooseFrame([picture]), 0);
    assert.equal(chooseFrame([black, picture]), 1);
    assert.equal(chooseFrame([black, picture, { mean: 120, spread: 70 }]), 1);
    assert.equal(chooseFrame([black, fade, black]), 1);
    assert.equal(chooseFrame([]), null);
  });
});
