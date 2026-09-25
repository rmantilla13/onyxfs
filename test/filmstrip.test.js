// Sprite-sheet geometry. The failures here are all visual and all silent: a
// tile showing a sliver of its neighbour, an empty tile at the right-hand edge
// of the bar, a sheet too wide for a mobile GPU to decode at all.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const {
  filmstripLayout, filmstripTimes, frameIndexAt, framePosition, layoutFromMetadata,
  FILMSTRIP_FRAMES, FILMSTRIP_COLUMNS, FILMSTRIP_TILE_WIDTH,
} = await import('../lib/filmstrip.js');

describe('filmstripLayout', () => {
  test('a 16:9 source tiles into rows of the configured width', () => {
    const l = filmstripLayout({ width: 1920, height: 1080 });
    assert.equal(l.tileWidth, FILMSTRIP_TILE_WIDTH);
    assert.equal(l.tileHeight, 90);
    assert.equal(l.columns, FILMSTRIP_COLUMNS);
    assert.equal(l.rows, FILMSTRIP_FRAMES / FILMSTRIP_COLUMNS);
    assert.equal(l.sheetWidth, FILMSTRIP_COLUMNS * FILMSTRIP_TILE_WIDTH);
    assert.equal(l.sheetHeight, l.rows * 90);
  });

  test('tile height is always even', () => {
    // An odd height puts sprite offsets on half pixels at some zoom levels and
    // the tile shows a sliver of the frame below it.
    for (const [w, h] of [[1920, 1080], [1080, 1920], [640, 483], [4096, 2160], [100, 37]]) {
      const l = filmstripLayout({ width: w, height: h });
      assert.equal(l.tileHeight % 2, 0, `${w}x${h} gave ${l.tileHeight}`);
    }
  });

  test('a portrait source is taller than it is wide', () => {
    const l = filmstripLayout({ width: 1080, height: 1920 });
    assert.ok(l.tileHeight > l.tileWidth);
  });

  test('the sheet never exceeds the 4096px texture limit at defaults', () => {
    // A single row of 40 tiles would be 6400px wide, which some mobile GPUs
    // refuse outright — and the whole strip then fails to decode, not just the
    // tiles past the limit.
    for (const [w, h] of [[1920, 1080], [1080, 1920], [4096, 2160]]) {
      const l = filmstripLayout({ width: w, height: h });
      assert.ok(l.sheetWidth <= 4096, `sheet ${l.sheetWidth}px wide`);
      assert.ok(l.sheetHeight <= 4096, `sheet ${l.sheetHeight}px tall`);
    }
  });

  test('rows cover every frame when the count does not divide evenly', () => {
    const l = filmstripLayout({ width: 1920, height: 1080, frames: 41, columns: 8 });
    assert.equal(l.rows, 6);
    assert.ok(l.rows * l.columns >= 41);
  });

  test('a source with no dimensions is null, not a 0x0 canvas', () => {
    // Encoding a zero-sized canvas throws in some browsers and yields a blank
    // image in others; the caller must skip instead.
    for (const bad of [{ width: 0, height: 0 }, { width: 1920 }, {}, undefined,
                       { width: NaN, height: 100 }, { width: -1920, height: -1080 }]) {
      assert.equal(filmstripLayout(bad), null, JSON.stringify(bad));
    }
  });
});

describe('filmstripTimes', () => {
  test('frames are spread across the clip, offset half a step', () => {
    // Starting at 0 captures the slate or a black frame, and a strip whose
    // first tile is black looks broken.
    const times = filmstripTimes(40, 40);
    assert.equal(times.length, 40);
    assert.equal(times[0], 0.5);
    assert.ok(times[0] > 0);
    assert.ok(times[39] < 40);
  });

  test('every time is inside the clip and strictly increasing', () => {
    for (const d of [0.5, 3, 97.3, 7200]) {
      const times = filmstripTimes(d);
      for (let i = 0; i < times.length; i++) {
        assert.ok(times[i] > 0 && times[i] <= d, `${times[i]} outside 0..${d}`);
        if (i) assert.ok(times[i] > times[i - 1], 'times must increase');
      }
    }
  });

  test('an unknown or zero duration yields no frames', () => {
    for (const bad of [0, -1, NaN, undefined, 'x']) {
      assert.deepEqual(filmstripTimes(bad), []);
    }
  });
});

describe('frameIndexAt', () => {
  test('maps time onto tiles', () => {
    assert.equal(frameIndexAt(0, 40, 40), 0);
    assert.equal(frameIndexAt(20, 40, 40), 20);
    assert.equal(frameIndexAt(39.5, 40, 40), 39);
  });

  test('the very end of the clip is the LAST tile, not one past it', () => {
    // THE bug. At exactly `duration` the ratio is 1 and `1 * count` indexes off
    // the end, which paints empty space at the right edge of the bar —
    // precisely where a scrub finishes.
    for (const count of [1, 8, 40, 41]) {
      assert.equal(frameIndexAt(40, 40, count), count - 1, `count ${count}`);
    }
  });

  test('out-of-range times are clamped', () => {
    assert.equal(frameIndexAt(-5, 40, 40), 0);
    assert.equal(frameIndexAt(1e9, 40, 40), 39);
  });

  test('no duration is tile 0, not NaN', () => {
    assert.equal(frameIndexAt(5, 0, 40), 0);
    assert.equal(frameIndexAt(5, NaN, 40), 0);
  });
});

describe('framePosition', () => {
  const layout = filmstripLayout({ width: 1920, height: 1080 });

  test('the first tile sits at the origin', () => {
    const p = framePosition(0, layout);
    assert.equal(p.backgroundPosition, '-0px -0px');
    assert.equal(p.width, '160px');
    assert.equal(p.height, '90px');
  });

  test('tiles advance across then down', () => {
    assert.equal(framePosition(1, layout).backgroundPosition, '-160px -0px');
    assert.equal(framePosition(7, layout).backgroundPosition, '-1120px -0px');
    assert.equal(framePosition(8, layout).backgroundPosition, '-0px -90px');
    assert.equal(framePosition(9, layout).backgroundPosition, '-160px -90px');
  });

  test('backgroundSize is in pixels, not percentages', () => {
    // A percentage background-size resolves against the element box, so the
    // tile rescales when the preview box changes and every offset drifts.
    const p = framePosition(0, layout);
    assert.match(p.backgroundSize, /^\d+px \d+px$/);
    assert.equal(p.backgroundSize, `${layout.sheetWidth}px ${layout.sheetHeight}px`);
  });

  test('an index past the end clamps to the last tile', () => {
    assert.equal(framePosition(999, layout).backgroundPosition,
                 framePosition(layout.frames - 1, layout).backgroundPosition);
    assert.equal(framePosition(-5, layout).backgroundPosition, '-0px -0px');
  });

  test('no layout is null, so a caller renders nothing', () => {
    assert.equal(framePosition(0, null), null);
  });
});

describe('layoutFromMetadata', () => {
  test('round trips what the generator stored', () => {
    const made = filmstripLayout({ width: 1920, height: 1080 });
    const stored = {
      filmstrip: {
        key: '_thumbs/abc.webp', frames: made.frames, columns: made.columns,
        tileWidth: made.tileWidth, tileHeight: made.tileHeight,
      },
    };
    const back = layoutFromMetadata(stored);
    assert.equal(back.tileWidth, made.tileWidth);
    assert.equal(back.tileHeight, made.tileHeight);
    assert.equal(back.sheetWidth, made.sheetWidth);
    assert.equal(back.sheetHeight, made.sheetHeight);
  });

  test('the STORED tile height wins over a recomputed one', () => {
    // It is what the sheet was actually encoded at. Recomputing from the
    // aspect ratio can differ by a pixel after rounding, and that shifts every
    // tile in the sheet.
    const back = layoutFromMetadata({
      filmstrip: { frames: 40, columns: 8, tileWidth: 160, tileHeight: 88 },
    });
    assert.equal(back.tileHeight, 88);
    assert.equal(back.sheetHeight, back.rows * 88);
  });

  test('a row with no filmstrip is null', () => {
    assert.equal(layoutFromMetadata(null), null);
    assert.equal(layoutFromMetadata({}), null);
    assert.equal(layoutFromMetadata({ filmstrip: null }), null);
  });
});
