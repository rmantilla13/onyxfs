// When a photo or a video was taken, read from the file itself at upload
// (lib/capture-date.js, lib/mp4-probe.js) — the file's own created date.
//
// The fixtures are real encoders' output, not bytes built to match the
// reader: the photos were written by ImageIO (what Photos and the camera use)
// with an EXIF DateTimeOriginal, with and without OffsetTimeOriginal; the
// videos by ffmpeg with `-metadata creation_time=…`, which is the mvhd box.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { photoCaptureDate, exifDateTime, tiffCaptureDate, heifExifItem } = await import('../lib/capture-date.js');
const { probeMp4 } = await import('../lib/mp4-probe.js');

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
function reader(bytes) {
  const reads = [];
  const readRange = async (start, end) => { reads.push([start, end]); return new Uint8Array(bytes.subarray(start, end)); };
  return { readRange, reads, size: bytes.length };
}
// Local time as a fixed zone would have it (UTC−4), so the tests do not
// depend on the machine's.
const edt = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi, s) + 4 * 3600_000;

describe('photos: EXIF DateTimeOriginal', () => {
  test('a JPEG with its offset is that instant', async () => {
    const { readRange, reads, size } = reader(fixture('photo-exif-offset.jpg'));
    assert.equal(await photoCaptureDate(readRange, { size }), Date.parse('2026-09-05T12:30:00Z'), '14:30 at +02:00');
    assert.ok(reads.length <= 2, 'two small reads');
  });

  test('a JPEG without one is the camera’s clock, taken as local time', async () => {
    const { readRange, size } = reader(fixture('photo-exif-local.jpg'));
    assert.equal(await photoCaptureDate(readRange, { size, local: edt }), Date.parse('2026-09-05T18:30:00Z'));
  });

  test('a HEIC’s is in its Exif item, found through the meta box', async () => {
    const { readRange, reads, size } = reader(fixture('photo-exif-offset.heic'));
    assert.equal(await photoCaptureDate(readRange, { size }), Date.parse('2026-09-05T16:15:42Z'), '09:15:42 at −07:00');
    assert.ok(reads.every(([s, e]) => e - s <= 1024), 'never the pixels');
    const local = reader(fixture('photo-exif-local.heic'));
    assert.equal(await photoCaptureDate(local.readRange, { size: local.size, local: edt }), Date.parse('2019-03-02T12:15:30Z'));
  });

  test('the Exif item’s place in the file, from iinf and iloc', () => {
    const heic = fixture('photo-exif-offset.heic');
    const at = heic.readUInt32BE(0); // the box after ftyp
    assert.equal(heic.subarray(at + 4, at + 8).toString('latin1'), 'meta');
    const item = heifExifItem(new Uint8Array(heic.subarray(at + 8, at + heic.readUInt32BE(at))));
    assert.equal(item.method, 0);
    assert.equal(item.extents.length, 1);
    assert.equal(heic.subarray(item.extents[0].offset + 4, item.extents[0].offset + 10).toString('latin1'), 'Exif\0\0');
  });

  test('a file that is not a photo, or says nothing, is null — never an error', async () => {
    for (const name of ['h264-25-head.mp4', 'video-created-2026-09-05.mp4']) {
      const { readRange, size } = reader(fixture(name));
      assert.equal(await photoCaptureDate(readRange, { size }), null, name);
    }
    const bare = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0, 0, 0, 0, 0, 0]);
    assert.equal(await photoCaptureDate(reader(bare).readRange, { size: bare.length }), null, 'a JPEG with no EXIF');
    const jpeg = fixture('photo-exif-offset.jpg');
    const cut = jpeg.subarray(0, 40);
    assert.equal(await photoCaptureDate(reader(cut).readRange, { size: cut.length }), null, 'cut off inside its EXIF');
    assert.equal(await photoCaptureDate(reader(new Uint8Array(8)).readRange, { size: 8 }), null, 'too short to be anything');
  });
});

describe('the EXIF date itself', () => {
  test('with an offset, either side of UTC', () => {
    assert.equal(exifDateTime('2026:09:05 14:30:00', '+02:00'), Date.parse('2026-09-05T12:30:00Z'));
    assert.equal(exifDateTime('2026:09:05 14:30:00', '-07:30'), Date.parse('2026-09-05T22:00:00Z'));
    assert.equal(exifDateTime('2026:09:05 14:30:00', '+00:00'), Date.parse('2026-09-05T14:30:00Z'));
  });

  test('what cameras write when they do not know is nothing', () => {
    for (const text of ['0000:00:00 00:00:00', '    :  :     :  :  ', '', null, '2026:13:01 00:00:00', '2026-09-05', '1969:12:31 23:59:59']) {
      assert.equal(exifDateTime(text, '+00:00'), null, String(text));
    }
  });

  test('a TIFF block in either byte order', () => {
    // A minimal EXIF body: IFD0 → ExifIFD → DateTimeOriginal, big-endian.
    const mm = [
      0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,             // "MM", 42, IFD0 at 8
      0x00, 0x01, 0x87, 0x69, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x1a, // ExifIFD at 26
      0x00, 0x00, 0x00, 0x00,                                     // no next IFD
      0x00, 0x01, 0x90, 0x03, 0x00, 0x02, 0x00, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00, 0x2c, // DateTimeOriginal, 20 bytes at 44
      0x00, 0x00, 0x00, 0x00,
      ...Buffer.from('2019:03:02 08:15:30\0', 'latin1'),
    ];
    assert.equal(tiffCaptureDate(new Uint8Array(mm), 0, mm.length, { local: edt }), Date.parse('2019-03-02T12:15:30Z'));
    // The same, little-endian, as most cameras other than Apple's write it.
    const ii = [
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x69, 0x87, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x1a, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x03, 0x90, 0x02, 0x00, 0x14, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      ...Buffer.from('2019:03:02 08:15:30\0', 'latin1'),
    ];
    assert.equal(tiffCaptureDate(new Uint8Array(ii), 0, ii.length, { local: edt }), Date.parse('2019-03-02T12:15:30Z'));
    assert.equal(tiffCaptureDate(new Uint8Array([0x49, 0x49, 0x2b, 0x00, 8, 0, 0, 0]), 0, 8), null, 'not TIFF');
  });
});

describe('videos: the mvhd creation time', () => {
  test('an MP4 and a MOV say when they were shot', async () => {
    for (const [name, at] of [['video-created-2026-09-05.mp4', '2026-09-05T14:30:00Z'], ['video-created-2019-03-02.mov', '2019-03-02T08:15:30Z']]) {
      const { readRange, size } = reader(fixture(name));
      const probe = await probeMp4(readRange, { size });
      assert.equal(probe.createdAt, Date.parse(at), name);
      assert.ok(probe.fps, 'and the frame model is still read');
    }
  });

  test('a movie that was never given one says nothing', async () => {
    for (const name of ['h264-23976-tail.mp4', 'h264-25-head.mp4', 'prores-2997df-tc.mov']) {
      const { readRange, size } = reader(fixture(name));
      assert.equal((await probeMp4(readRange, { size })).createdAt, null, name);
    }
  });
});
