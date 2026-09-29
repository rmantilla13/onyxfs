// A picture's size from its header (lib/image-header.js), which the preview
// worker decodes to. A wrong answer is a squeezed or sideways thumbnail and a
// wrong size on record, so the size given has to be the one an <img> reports
// — orientation applied — and null wherever browsers might not agree on it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { imageHeaderSize, exifOrientation } from '../lib/image-header.js';

// ── building headers ──
const seg = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
const sof = (w, h, marker = 0xc0) => seg(marker, Buffer.from([8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]));
const SOS = Buffer.concat([seg(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0])), Buffer.from([0x12, 0x34, 0x56, 0xff, 0xd9])]);
const APP0 = seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'));
const jpeg = (...segments) => Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, SOS]);

function tiff(entries, { little = false } = {}) {
  const u16 = (n) => (little ? [n & 255, (n >> 8) & 255] : [(n >> 8) & 255, n & 255]);
  const u32 = (n) => (little ? [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24] : [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
  const out = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...u16(entries.length)];
  for (const { tag, type = 3, count = 1, value } of entries) {
    out.push(...u16(tag), ...u16(type), ...u32(count), ...(type === 3 ? [...u16(value), 0, 0] : u32(value)));
  }
  out.push(...u32(0));
  return Buffer.from(out);
}
const exif = (entries, opts) => seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff(entries, opts)]));
const orient = (n, opts) => exif([{ tag: 0x0112, value: n }], opts);
const xmp = (body) => seg(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${body}</x:xmpmeta>`, 'latin1'));

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  return out; // no CRC checked here
}
const ihdr = (w, h) => { const d = Buffer.alloc(13); d.writeUInt32BE(w, 0); d.writeUInt32BE(h, 4); d[8] = 8; d[9] = 6; return pngChunk('IHDR', d); };
const png = (w, h, ...before) => Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), ihdr(w, h), ...before, pngChunk('IDAT', Buffer.alloc(20)), pngChunk('IEND', Buffer.alloc(0))]);

const riff = (chunk) => { const b = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP', 'latin1'), chunk]); b.writeUInt32LE(b.length - 8, 4); return b; };
const webpChunk = (id, data) => { const h = Buffer.alloc(8); h.write(id, 0, 'latin1'); h.writeUInt32LE(data.length, 4); return Buffer.concat([h, data, Buffer.alloc(data.length & 1)]); };
function vp8(w, h) {
  const d = Buffer.alloc(20);
  d[3] = 0x9d; d[4] = 0x01; d[5] = 0x2a;
  d.writeUInt16LE(w, 6); d.writeUInt16LE(h, 8);
  return webpChunk('VP8 ', d);
}
function vp8l(w, h) {
  const d = Buffer.alloc(10);
  d[0] = 0x2f;
  d.writeUInt32LE(((w - 1) | ((h - 1) << 14)) >>> 0, 1);
  return webpChunk('VP8L', d);
}
function vp8x(w, h, flags) {
  const d = Buffer.alloc(10);
  d[0] = flags;
  d.writeUIntLE(w - 1, 4, 3); d.writeUIntLE(h - 1, 7, 3);
  return Buffer.concat([webpChunk('VP8X', d), vp8(w, h)]);
}

// ── reading them ──
function reader(buf) {
  const reads = [];
  const readRange = async (start, end) => { reads.push(end - start); return new Uint8Array(buf.subarray(start, end)); };
  return { readRange, reads };
}
const sizeOf = (buf) => imageHeaderSize(reader(buf).readRange, { size: buf.length });

describe('a JPEG', () => {
  test('its frame header, as it is when it says no orientation', async () => {
    assert.deepEqual(await sizeOf(jpeg(sof(4000, 3000))), { type: 'jpeg', width: 4000, height: 3000 });
    assert.deepEqual(await sizeOf(jpeg(APP0, orient(1), sof(6000, 4000, 0xc2))), { type: 'jpeg', width: 6000, height: 4000 }, 'progressive');
  });

  test('turned by its EXIF orientation, as every browser turns it, in either byte order', async () => {
    for (const little of [false, true]) {
      for (const n of [1, 2, 3, 4]) assert.deepEqual(await sizeOf(jpeg(orient(n, { little }), sof(4032, 3024))), { type: 'jpeg', width: 4032, height: 3024 }, `${n}`);
      for (const n of [5, 6, 7, 8]) assert.deepEqual(await sizeOf(jpeg(orient(n, { little }), sof(4032, 3024))), { type: 'jpeg', width: 3024, height: 4032 }, `${n}`);
    }
  });

  test('an orientation browsers could read differently: null, and the page draws it', async () => {
    const f = sof(4032, 3024);
    assert.equal(await sizeOf(jpeg(xmp(''), orient(6), f)), null, 'EXIF behind another APP1: Firefox reads only the first');
    assert.equal(await sizeOf(jpeg(orient(1), orient(6), f)), null, 'two EXIF blocks');
    assert.equal(await sizeOf(jpeg(exif([{ tag: 0x0112, type: 4, value: 6 }]), f)), null, 'a LONG');
    assert.equal(await sizeOf(jpeg(exif([{ tag: 0x0112, count: 2, value: 6 }]), f)), null, 'two values');
    assert.equal(await sizeOf(jpeg(orient(0), f)), null);
    assert.equal(await sizeOf(jpeg(orient(9), f)), null);
    assert.equal(await sizeOf(jpeg(exif([{ tag: 0x0112, value: 6 }, { tag: 0x0112, value: 1 }]), f)), null, 'said twice');
    assert.equal(await sizeOf(jpeg(orient(6), xmp('<rdf:Description tiff:Orientation="1"/>'), f)), null, 'XMP says otherwise');
    assert.equal(await sizeOf(jpeg(xmp('<tiff:Orientation>8</tiff:Orientation>'), f)), null, 'XMP alone says turn it');
  });

  test('XMP that agrees, or says nothing about it, changes nothing', async () => {
    const f = sof(4032, 3024);
    assert.deepEqual(await sizeOf(jpeg(orient(6), xmp('<rdf:Description tiff:Orientation="6"/>'), f)), { type: 'jpeg', width: 3024, height: 4032 });
    assert.deepEqual(await sizeOf(jpeg(orient(6), xmp('<tiff:Orientation> 6 </tiff:Orientation>'), f)), { type: 'jpeg', width: 3024, height: 4032 });
    assert.deepEqual(await sizeOf(jpeg(xmp('<rdf:Description tiff:Orientation="1"/>'), f)), { type: 'jpeg', width: 4032, height: 3024 });
    assert.deepEqual(await sizeOf(jpeg(orient(3), xmp('<dc:title>x</dc:title>'), f)), { type: 'jpeg', width: 4032, height: 3024 });
  });

  test('megabytes of metadata ahead of the frame are stepped over, not read', async () => {
    // A portrait photo's depth map in extended XMP, a colour profile in parts.
    const ext = seg(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xmp/extension/\0', 'latin1'), Buffer.alloc(65000, 0x41)]));
    const icc = seg(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.alloc(60000)]));
    const file = jpeg(orient(6), ...Array(48).fill(ext), icc, icc, sof(4000, 3000));
    const { readRange, reads } = reader(file);
    assert.ok(file.length > 3_000_000);
    assert.deepEqual(await imageHeaderSize(readRange, { size: file.length }), { type: 'jpeg', width: 3000, height: 4000 });
    const read = reads.reduce((a, n) => a + n, 0);
    assert.ok(read < 70 * 1024, `read ${read} bytes`);
  });

  test('no frame header, a broken one, or none before the image data: null', async () => {
    assert.equal(await sizeOf(jpeg(APP0)), null);
    assert.equal(await sizeOf(jpeg(sof(0, 3000))), null, 'a height given later, by DNL');
    assert.equal(await sizeOf(jpeg(sof(4000, 3000), sof(4000, 3000))), null);
    assert.equal(await sizeOf(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
    assert.equal(await sizeOf(jpeg(sof(4000, 3000)).subarray(0, 20)), null, 'cut short of the image data');
    assert.equal(await sizeOf(Buffer.concat([Buffer.from([0xff, 0xd8]), sof(40, 30), Buffer.from([0x00, 0x11]), SOS])), null, 'lost its markers');
  });
});

describe('a PNG', () => {
  test('its IHDR, when nothing before the image data says to turn it', async () => {
    assert.deepEqual(await sizeOf(png(3840, 2160)), { type: 'png', width: 3840, height: 2160 });
    const text = pngChunk('iTXt', Buffer.alloc(200_000, 0x20));
    // A density (pHYs) changes nothing: no browser sizes a PNG by it.
    const dpi144 = pngChunk('pHYs', Buffer.from([0, 0, 0x16, 0x25, 0, 0, 0x16, 0x25, 1]));
    assert.deepEqual(await sizeOf(png(3840, 2160, pngChunk('iCCP', Buffer.alloc(3000)), dpi144, text)), { type: 'png', width: 3840, height: 2160 });
  });

  test('an eXIf chunk — Chrome turns the picture by it, not every browser does — or no IDAT: null', async () => {
    assert.equal(await sizeOf(png(3840, 2160, pngChunk('eXIf', tiff([{ tag: 0x0112, value: 6 }])))), null);
    assert.equal(await sizeOf(png(3840, 2160).subarray(0, 40)), null);
    const bad = png(3840, 2160);
    bad.write('IHDX', 12, 'latin1');
    assert.equal(await sizeOf(bad), null);
    assert.equal(await sizeOf(png(0, 2160)), null);
  });
});

describe('a WebP', () => {
  test('lossy, lossless and extended', async () => {
    assert.deepEqual(await sizeOf(riff(vp8(4000, 3000))), { type: 'webp', width: 4000, height: 3000 });
    assert.deepEqual(await sizeOf(riff(vp8l(1234, 567))), { type: 'webp', width: 1234, height: 567 });
    assert.deepEqual(await sizeOf(riff(vp8x(16383, 9000, 0x30))), { type: 'webp', width: 16383, height: 9000 }, 'alpha and a colour profile');
  });

  test('with EXIF — Chrome ignores its orientation, another browser may not — null', async () => {
    assert.equal(await sizeOf(riff(vp8x(4000, 3000, 0x08))), null);
  });
});

test('everything else is the page’s to draw', async () => {
  const gif = Buffer.from('GIF89a\x10\x00\x08\x00\x80\x00\x00', 'latin1');
  const bmp = Buffer.concat([Buffer.from('BM', 'latin1'), Buffer.alloc(60)]);
  const avif = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif', 'latin1'), Buffer.alloc(40)]);
  const tif = Buffer.concat([Buffer.from('II*\0', 'latin1'), Buffer.alloc(40)]);
  for (const buf of [gif, bmp, avif, tif, Buffer.from('not a picture'), Buffer.alloc(0)]) assert.equal(await sizeOf(buf), null);
  assert.equal(await imageHeaderSize(reader(png(10, 10)).readRange, {}), null, 'no size, nothing read');
});

test('exifOrientation reads IFD0 in either order, and 1 when there is none', () => {
  assert.equal(exifOrientation(tiff([{ tag: 0x0112, value: 8 }])), 8);
  assert.equal(exifOrientation(tiff([{ tag: 0x0112, value: 5 }], { little: true })), 5);
  assert.equal(exifOrientation(tiff([{ tag: 0x010f, type: 4, value: 0 }])), 1);
  assert.equal(exifOrientation(Buffer.from('MM\0\x2a\0\0\x10\0', 'latin1')), null, 'IFD0 past the end');
  assert.equal(exifOrientation(Buffer.from('XX\0\x2a\0\0\0\x08\0\0\0\0\0\0', 'latin1')), null);
});

// What real encoders write — sharp's libjpeg, libpng, libwebp, libheif —
// against what they say they wrote.
test('files as encoders write them', async (t) => {
  const sharp = (await import('sharp').catch(() => null))?.default;
  if (!sharp) return t.skip('sharp is not installed here');
  const raw = { raw: { width: 300, height: 200, channels: 3 } };
  const px = Buffer.alloc(300 * 200 * 3, 128);
  const cases = [
    [await sharp(px, raw).jpeg().toBuffer(), { type: 'jpeg', width: 300, height: 200 }],
    [await sharp(px, raw).jpeg({ progressive: true }).withMetadata({ orientation: 6 }).toBuffer(), { type: 'jpeg', width: 200, height: 300 }],
    [await sharp(px, raw).jpeg().withMetadata({ orientation: 3, density: 300 }).toBuffer(), { type: 'jpeg', width: 300, height: 200 }],
    [await sharp(px, raw).png().toBuffer(), { type: 'png', width: 300, height: 200 }],
    // Its metadata kept, sharp writes an eXIf chunk: the page's to draw.
    [await sharp(px, raw).png().withMetadata({ density: 144 }).toBuffer(), null],
    [await sharp(px, raw).webp().toBuffer(), { type: 'webp', width: 300, height: 200 }],
    [await sharp(px, raw).webp({ lossless: true }).toBuffer(), { type: 'webp', width: 300, height: 200 }],
    [await sharp(px, { raw: { ...raw.raw } }).ensureAlpha(0.5).webp().toBuffer(), { type: 'webp', width: 300, height: 200 }],
    [await sharp(px, raw).webp().withMetadata({ orientation: 6 }).toBuffer(), null],
    [await sharp(px, raw).gif().toBuffer(), null],
    [await sharp(px, raw).avif().toBuffer().catch(() => null), null],
  ];
  for (const [buf, want] of cases) {
    if (!buf) continue;
    assert.deepEqual(await sizeOf(buf), want, `${(await sharp(buf).metadata()).format} → ${JSON.stringify(want)}`);
  }
});
