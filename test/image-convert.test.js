// The "Download as…" converter's arithmetic, without a browser: which way up
// a photo goes (lib/exif-orientation.js) — its EXIF parser and its canvas
// transforms checked against libvips, through sharp, on real JPEGs — and the
// pipeline that decodes, turns, scales down by halves and encodes
// (lib/image-convert.js), run against a canvas that records what is drawn.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { exifOrientation, orientationTransform, orientedSize, swapsAxes } from '../lib/exif-orientation.js';
import { renderPicture, convertBlob, decoderAppliesOrientation, orientationProbe, ConvertError } from '../lib/image-convert.js';
import { formatById, MOBILE_MAX_CANVAS_PIXELS } from '../lib/download-formats.js';

// Six blocks, 3 across and 2 down, each its own colour: every one of the
// eight orientations puts them somewhere different.
const B = 16;
const W = 3 * B;
const H = 2 * B;
const COLOURS = [[230, 20, 20], [20, 200, 20], [20, 20, 230], [230, 230, 20], [20, 220, 220], [220, 20, 220]];
function blocks() {
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = COLOURS[Math.floor(y / B) * 3 + Math.floor(x / B)];
      raw.set(c, (y * W + x) * 3);
    }
  }
  return raw;
}
const jpegWith = (orientation) => sharp(blocks(), { raw: { width: W, height: H, channels: 3 } })
  .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
  .withMetadata({ orientation })
  .toBuffer();

describe('reading the orientation', () => {
  test('every orientation a camera writes, as libvips writes it', async () => {
    for (let o = 1; o <= 8; o++) {
      const jpeg = await jpegWith(o);
      assert.equal(exifOrientation(new Uint8Array(jpeg)), o, `orientation ${o}`);
      assert.equal(exifOrientation(jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength)), o, 'an ArrayBuffer too');
    }
  });

  test('a TIFF keeps it in its first directory', async () => {
    const tiff = await sharp(blocks(), { raw: { width: W, height: H, channels: 3 } }).tiff().withMetadata({ orientation: 8 }).toBuffer();
    assert.equal((await sharp(tiff).metadata()).orientation, 8);
    assert.equal(exifOrientation(new Uint8Array(tiff)), 8);
  });

  test('big-endian EXIF, and a LONG where the standard says SHORT', () => {
    const app1 = (tiff) => {
      const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
      const len = payload.length + 2;
      return [0xff, 0xe1, len >> 8, len & 0xff, ...payload];
    };
    const motorola = [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0];
    assert.equal(exifOrientation(new Uint8Array([0xff, 0xd8, ...app1(motorola), 0xff, 0xd9])), 3);
    const long = [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 4, 0, 1, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0];
    assert.equal(exifOrientation(new Uint8Array([0xff, 0xd8, ...app1(long), 0xff, 0xd9])), 7);
    // After a JFIF segment, as most cameras' files have one.
    const jfif = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
    assert.equal(exifOrientation(new Uint8Array([0xff, 0xd8, ...jfif, ...app1(motorola)])), 3);
  });

  test('none, or nothing sensible, is upright', async () => {
    const plain = await sharp(blocks(), { raw: { width: W, height: H, channels: 3 } }).jpeg().toBuffer();
    assert.equal(exifOrientation(new Uint8Array(plain)), 1, 'no EXIF');
    const png = await sharp(blocks(), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
    assert.equal(exifOrientation(new Uint8Array(png)), 1, 'a PNG');
    const six = new Uint8Array(await jpegWith(6));
    for (const n of [0, 3, 12, 24, 30]) assert.equal(exifOrientation(six.slice(0, n)), 1, `cut at ${n}`);
    assert.equal(exifOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 1])), 1, 'a length that cannot be');
    assert.equal(exifOrientation(null), 1);
    assert.equal(exifOrientation(new Uint8Array(64).fill(0xff)), 1);
    // An out-of-range value reads as upright rather than as garbage.
    const nine = [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0];
    const len = nine.length + 8;
    assert.equal(exifOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0, ...nine])), 1);
  });

  test('the probe picture: stored 16 × 8, orientation 6, shown 8 × 16', async () => {
    const bytes = Buffer.from(await orientationProbe().arrayBuffer());
    assert.equal(exifOrientation(new Uint8Array(bytes)), 6);
    const md = await sharp(bytes).metadata();
    assert.deepEqual([md.width, md.height, md.orientation], [16, 8, 6]);
    const shown = await sharp(bytes).rotate().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([shown.info.width, shown.info.height], [8, 16]);
  });
});

describe('turning it the right way up', () => {
  test('each transform puts every block where libvips puts it', async () => {
    for (let o = 1; o <= 8; o++) {
      const { data, info } = await sharp(await jpegWith(o)).rotate().raw().toBuffer({ resolveWithObject: true });
      assert.deepEqual({ width: info.width, height: info.height }, orientedSize({ width: W, height: H }, o), `size, orientation ${o}`);
      const [a, b, c, d, e, f] = orientationTransform(o, W, H);
      for (let i = 0; i < COLOURS.length; i++) {
        const x = (i % 3) * B + B / 2;
        const y = Math.floor(i / 3) * B + B / 2;
        const X = Math.floor(a * x + c * y + e);
        const Y = Math.floor(b * x + d * y + f);
        assert.ok(X >= 0 && X < info.width && Y >= 0 && Y < info.height, `orientation ${o}: block ${i} lands inside`);
        const at = (Y * info.width + X) * info.channels;
        const got = [data[at], data[at + 1], data[at + 2]];
        assert.ok(got.every((v, k) => Math.abs(v - COLOURS[i][k]) < 40), `orientation ${o}: block ${i} is ${got}, not ${COLOURS[i]}`);
      }
    }
  });

  test('a quarter turn trades width and height; the rest keep them', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(swapsAxes), [false, false, false, false, true, true, true, true]);
    assert.deepEqual(orientationTransform(1, 10, 5), [1, 0, 0, 1, 0, 0]);
    assert.deepEqual(orientationTransform(0, 10, 5), [1, 0, 0, 1, 0, 0], 'no orientation is upright');
    assert.deepEqual(orientationTransform(9, 10, 5), [1, 0, 0, 1, 0, 0]);
  });
});

// A canvas that records what is done to it, and an encoder that answers with
// the type it is told to (or `writes`, to play a browser that cannot).
function recorder({ writes = null } = {}) {
  const canvases = [];
  const env = {
    decode: async () => { throw new Error('not used'); },
    canvas: (width, height) => {
      const calls = [];
      const ctx = {
        fillRect: (...a) => calls.push(['fillRect', ...a]),
        setTransform: (...a) => calls.push(['setTransform', ...a]),
        drawImage: (src, ...a) => calls.push(['drawImage', src, ...a]),
      };
      const c = { width, height, made: { width, height }, calls, getContext: () => ctx };
      canvases.push(c);
      return c;
    },
    encode: async (canvas, type, quality) => ({ type: writes || type, quality, made: canvas.made }),
  };
  return { env, canvases };
}
const SOURCE = { name: 'the decoded picture' };

describe('scaling and encoding', () => {
  test('down by halves at most, straight from the picture first, and encoded as asked', async () => {
    const { env, canvases } = recorder();
    const out = await renderPicture(SOURCE, { width: 4032, height: 3024 }, { format: formatById('png'), longEdge: 1080, env });
    assert.deepEqual(canvases.map((c) => [c.made.width, c.made.height]), [[2016, 1512], [1080, 810]]);
    assert.deepEqual(canvases[0].calls, [['drawImage', SOURCE, 0, 0, 2016, 1512]]);
    assert.deepEqual(canvases[1].calls, [['drawImage', canvases[0], 0, 0, 1080, 810]]);
    for (let i = 1; i < canvases.length; i++) assert.ok(canvases[i - 1].made.width <= canvases[i].made.width * 2);
    assert.equal(out.blob.type, 'image/png');
    assert.deepEqual([out.width, out.height], [1080, 810]);
    assert.deepEqual(out.source, { width: 4032, height: 3024 });
    assert.equal(canvases[0].width, 0, 'an intermediate gives its pixels back');
  });

  test('a JPEG is laid on white, and asked for at 0.9', async () => {
    const { env, canvases } = recorder();
    const out = await renderPicture(SOURCE, { width: 800, height: 600 }, { format: formatById('jpeg'), env });
    assert.equal(canvases.length, 1, 'full size: one draw');
    assert.deepEqual(canvases[0].calls, [['fillRect', 0, 0, 800, 600], ['drawImage', SOURCE, 0, 0, 800, 600]]);
    assert.equal(out.blob.quality, 0.9);
    const png = recorder();
    await renderPicture(SOURCE, { width: 800, height: 600 }, { format: formatById('png'), env: png.env });
    assert.ok(!png.canvases[0].calls.some(([op]) => op === 'fillRect'), 'a PNG keeps its transparency');
  });

  test('never scaled up: a size past the picture’s is its full size', async () => {
    const { env, canvases } = recorder();
    const out = await renderPicture(SOURCE, { width: 800, height: 600 }, { format: formatById('png'), longEdge: 1920, env });
    assert.deepEqual([out.width, out.height], [800, 600]);
    assert.deepEqual(canvases.map((c) => [c.made.width, c.made.height]), [[800, 600]]);
  });

  test('turned by the orientation on the first draw only, drawn in the stored shape', async () => {
    const { env, canvases } = recorder();
    // Stored 4032 × 3024, a quarter clockwise: shown 3024 × 4032.
    const out = await renderPicture(SOURCE, { width: 4032, height: 3024 }, { orientation: 6, turn: true, format: formatById('jpeg'), longEdge: 1920, env });
    assert.deepEqual([out.width, out.height], [1440, 1920]);
    assert.deepEqual(out.source, { width: 3024, height: 4032 });
    assert.deepEqual(canvases.map((c) => [c.made.width, c.made.height]), [[1512, 2016], [1440, 1920]]);
    assert.deepEqual(canvases[0].calls, [
      ['setTransform', ...orientationTransform(6, 2016, 1512)],
      ['drawImage', SOURCE, 0, 0, 2016, 1512],
      ['setTransform', 1, 0, 0, 1, 0, 0],
    ]);
    assert.ok(!canvases[1].calls.some(([op]) => op === 'setTransform'));
    // A decoder that turned it already: drawn as it came.
    const done = recorder();
    await renderPicture(SOURCE, { width: 3024, height: 4032 }, { orientation: 6, turn: false, format: formatById('png'), env: done.env });
    assert.deepEqual(done.canvases[0].calls, [['drawImage', SOURCE, 0, 0, 3024, 4032]]);
  });

  test('a browser that cannot write the format says so, rather than saving a PNG named .webp', async () => {
    const { env } = recorder({ writes: 'image/png' });
    await assert.rejects(
      renderPicture(SOURCE, { width: 100, height: 100 }, { format: formatById('webp'), env }),
      (e) => e instanceof ConvertError && e.code === 'encode' && /WebP/.test(e.message),
    );
    const failing = recorder();
    failing.env.encode = async () => { throw new Error('toBlob said null'); };
    await assert.rejects(renderPicture(SOURCE, { width: 100, height: 100 }, { format: formatById('jpeg'), env: failing.env }), (e) => e.code === 'encode');
  });

  test('more pixels than a canvas here holds is refused before anything is drawn', async () => {
    const { env, canvases } = recorder();
    await assert.rejects(
      renderPicture(SOURCE, { width: 8000, height: 6000 }, { format: formatById('jpeg'), maxPixels: MOBILE_MAX_CANVAS_PIXELS, env }),
      (e) => e.code === 'pixels',
    );
    assert.equal(canvases.length, 0);
    // The same picture at a size that fits.
    const ok = await renderPicture(SOURCE, { width: 8000, height: 6000 }, { format: formatById('jpeg'), longEdge: 3840, maxPixels: MOBILE_MAX_CANVAS_PIXELS, env });
    assert.deepEqual([ok.width, ok.height], [3840, 2880]);
  });

  test('a picture with no size is a decode failure, not a zero-pixel file', async () => {
    const { env } = recorder();
    await assert.rejects(renderPicture(SOURCE, { width: 0, height: 0 }, { format: formatById('png'), env }), (e) => e.code === 'decode');
  });
});

describe('a picture file, end to end', () => {
  // Decoders that answer with the picture's stored size (one that ignores
  // EXIF) or its shown size (one that applies it), as sharp reads them.
  const ignoring = async (blob) => {
    const md = await sharp(Buffer.from(await blob.arrayBuffer())).metadata();
    return { width: md.width, height: md.height, close() {} };
  };
  const applying = async (blob) => {
    const md = await sharp(Buffer.from(await blob.arrayBuffer())).metadata();
    return { ...orientedSize({ width: md.width, height: md.height }, md.orientation || 1), close() {} };
  };

  test('whether a decoder turns pictures itself is asked of it once, with the probe', async () => {
    assert.equal(await decoderAppliesOrientation(ignoring), false);
    assert.equal(await decoderAppliesOrientation(applying), true);
    let asked = 0;
    const broken = async () => { asked++; throw new Error('cannot decode anything'); };
    assert.equal(await decoderAppliesOrientation(broken), true, 'a probe that fails assumes a current engine');
    await decoderAppliesOrientation(broken);
    assert.equal(asked, 1, 'once per decoder');
  });

  test('a sideways photo comes out upright whether or not the decoder turned it', async () => {
    const file = new Blob([await jpegWith(6)], { type: 'image/jpeg' });
    for (const decode of [ignoring, applying]) {
      const { env, canvases } = recorder();
      env.decode = decode;
      const out = await convertBlob(file, { format: formatById('png'), env });
      assert.deepEqual([out.width, out.height], [H, W], decode === ignoring ? 'turned here' : 'turned by the decoder');
      const turned = canvases[0].calls.some(([op]) => op === 'setTransform');
      assert.equal(turned, decode === ignoring);
    }
  });

  test('an upright photo is never turned, and a decode failure says so', async () => {
    const { env, canvases } = recorder();
    env.decode = ignoring;
    const out = await convertBlob(new Blob([await jpegWith(1)]), { format: formatById('jpeg'), longEdge: 24, env });
    assert.deepEqual([out.width, out.height], [24, 16]);
    assert.ok(!canvases.some((c) => c.calls.some(([op]) => op === 'setTransform')));
    const bad = recorder();
    bad.env.decode = async () => { throw new Error('unsupported'); };
    await assert.rejects(convertBlob(new Blob([new Uint8Array(10)]), { format: formatById('jpeg'), env: bad.env }), (e) => e.code === 'decode');
  });
});
