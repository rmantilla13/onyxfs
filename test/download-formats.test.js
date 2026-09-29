// "Download as…": which choices a file gets, how big each copy comes out,
// and what it is called (lib/download-formats.js) — the rules the dialog,
// the browser's converter and the download routes all read.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  downloadChoices, offersDownloadAs, conversionSource, sizeChoices, targetSize, recordedSize, proxyHeight,
  IMAGE_FORMATS, LONG_EDGES, CONVERT_MAX_BYTES, MAX_CANVAS_PIXELS, MOBILE_MAX_CANVAS_PIXELS,
  parseDownloadVariant, DOWNLOAD_VARIANTS, formatById,
  downloadName, sanitizeFilename, splitName, imageDownloadName, proxyDownloadName, coverDownloadName,
  frameDownloadName, storedCoverFormat,
} from '../lib/download-formats.js';
import { orientedSize } from '../lib/exif-orientation.js';
import { THUMB_SOURCE_MAX_BYTES } from '../lib/media.js';

const MB = 1024 * 1024;
const photo = (extra = {}) => ({
  id: 'p1', name: 'IMG_0001.jpg', mime: 'image/jpeg', kind: 'image', size: 5 * MB,
  url: 'https://s3.test/onyx/team/IMG_0001.jpg?X-Amz-Signature=x', metadata: { width: 4032, height: 3024 }, ...extra,
});
const clip = (extra = {}) => ({
  id: 'v1', name: 'Master.mov', mime: 'video/quicktime', kind: 'video', size: 4e9,
  url: 'https://s3.test/onyx/team/Master.mov?X-Amz-Signature=x', metadata: { width: 3840, height: 2160 }, ...extra,
});
const ids = (list) => list.map((x) => x.id);

describe('which choices a file gets', () => {
  test('a photo: the two formats every canvas writes, at full size and each smaller long edge', () => {
    const c = downloadChoices(photo());
    assert.equal(c.kind, 'image');
    assert.equal(c.reason, null);
    assert.deepEqual(ids(c.formats), ['jpeg', 'png']);
    assert.deepEqual(c.sizes.map((s) => [s.id, s.width, s.height]), [
      ['full', 4032, 3024], ['3840', 3840, 2880], ['1920', 1920, 1440], ['1080', 1080, 810],
    ]);
    assert.equal(c.original.label, 'Original');
    assert.equal(c.original.detail, 'JPG · 5.0 MB');
    assert.equal(c.proxy, null);
    assert.equal(c.still, null);
    assert.ok(offersDownloadAs(photo()));
  });

  test('WebP and AVIF only where this browser’s encoder was seen to write them', () => {
    assert.deepEqual(ids(downloadChoices(photo(), { encoders: { webp: true, avif: false } }).formats), ['jpeg', 'png', 'webp']);
    assert.deepEqual(ids(downloadChoices(photo(), { encoders: { webp: true, avif: true } }).formats), ['jpeg', 'png', 'webp', 'avif']);
    assert.deepEqual(ids(downloadChoices(photo(), { encoders: { webp: false, avif: true } }).formats), ['jpeg', 'png', 'avif']);
    // Not asked yet is not a yes.
    assert.deepEqual(ids(downloadChoices(photo(), { encoders: null }).formats), ['jpeg', 'png']);
    assert.deepEqual(IMAGE_FORMATS.filter((f) => f.probed).map((f) => f.id), ['webp', 'avif']);
  });

  test('only sizes smaller than the original: a small picture is offered full size alone', () => {
    assert.deepEqual(ids(downloadChoices(photo({ metadata: { width: 1600, height: 1200 } })).sizes), ['full', '1080']);
    assert.deepEqual(ids(downloadChoices(photo({ metadata: { width: 1080, height: 720 } })).sizes), ['full']);
    assert.deepEqual(ids(downloadChoices(photo({ metadata: { width: 900, height: 600 } })).sizes), ['full']);
    // A long edge equal to one on offer is that size already.
    assert.deepEqual(ids(downloadChoices(photo({ metadata: { width: 1920, height: 1080 } })).sizes), ['full', '1080']);
  });

  test('with no size on record every size is offered, measured after decoding', () => {
    const c = downloadChoices(photo({ metadata: {} }));
    assert.deepEqual(ids(c.sizes), ['full', ...LONG_EDGES.map(String)]);
    assert.ok(c.sizes.every((s) => s.width === null && s.height === null));
    assert.deepEqual(c.sizes.map((s) => s.longEdge), [null, 3840, 1920, 1080]);
  });

  test('HEIC and TIFF only where this browser decodes them', () => {
    const heic = photo({ name: 'IMG_0002.HEIC', mime: 'image/heic' });
    assert.equal(downloadChoices(heic).reason, 'decode');
    assert.equal(offersDownloadAs(heic), false);
    assert.equal(offersDownloadAs(heic, { probe: { heic: false, tiff: true } }), false);
    assert.equal(offersDownloadAs(heic, { probe: { heic: true, tiff: false } }), true);
    const tiff = photo({ name: 'Scan.tif', mime: 'image/tiff' });
    assert.equal(offersDownloadAs(tiff), false);
    assert.equal(offersDownloadAs(tiff, { probe: { heic: true, tiff: false } }), false);
    assert.equal(offersDownloadAs(tiff, { probe: { heic: false, tiff: true } }), true);
  });

  test('anything the browser cannot decode gets the original alone', () => {
    const raw = photo({ name: 'DSC_1.NEF', mime: 'image/x-nikon-nef' });
    const svg = photo({ name: 'Logo.svg', mime: 'image/svg+xml' });
    for (const f of [raw, svg]) {
      const c = downloadChoices(f, { probe: { heic: true, tiff: true } });
      assert.equal(c.reason, 'decode', f.name);
      assert.deepEqual(c.formats, []);
      assert.deepEqual(c.sizes, []);
      assert.equal(offersDownloadAs(f), false, f.name);
    }
  });

  test('a GIF animates: a copy would be its first frame, so the original alone', () => {
    assert.equal(conversionSource(photo({ name: 'Loop.gif', mime: 'image/gif' })).reason, 'animated');
    assert.equal(conversionSource(photo({ name: 'Loop.gif', mime: '' })).reason, 'animated');
    assert.equal(offersDownloadAs(photo({ name: 'Loop.gif', mime: 'image/gif' })), false);
  });

  test('past the size cap the thumbnails use, the original alone — at the cap, still converted', () => {
    assert.equal(CONVERT_MAX_BYTES, THUMB_SOURCE_MAX_BYTES);
    assert.equal(downloadChoices(photo({ size: CONVERT_MAX_BYTES + 1 })).reason, 'size');
    assert.equal(offersDownloadAs(photo({ size: CONVERT_MAX_BYTES + 1 })), false);
    assert.equal(offersDownloadAs(photo({ size: CONVERT_MAX_BYTES })), true);
    // No size on record: offered, and the download itself stops at the cap.
    assert.equal(offersDownloadAs(photo({ size: null })), true);
  });

  test('a row with nothing to read the picture from has nothing to convert', () => {
    assert.equal(conversionSource(photo({ url: null })).reason, 'source');
  });

  test('a full-size copy only where one canvas can hold it — a phone’s is 4096²', () => {
    const big = photo({ size: 40 * MB, metadata: { width: 8000, height: 6000 } });
    assert.deepEqual(ids(downloadChoices(big).sizes), ['full', '3840', '1920', '1080']);
    const phone = downloadChoices(big, { maxPixels: MOBILE_MAX_CANVAS_PIXELS });
    assert.deepEqual(ids(phone.sizes), ['3840', '1920', '1080']);
    assert.ok(phone.sizes.every((s) => s.width * s.height <= MOBILE_MAX_CANVAS_PIXELS));
    assert.equal(MAX_CANVAS_PIXELS, 16384 * 16384);
    // Nothing fits at all: nothing offered.
    const none = downloadChoices(big, { maxPixels: 1000 });
    assert.equal(none.reason, 'pixels');
    assert.equal(offersDownloadAs(big, { maxPixels: 1000 }), false);
  });

  test('a video: its proxy when it has one, and a still — from the player’s frame or the cover', () => {
    const c = downloadChoices(clip(), { proxy: { available: true, size: 312 * MB }, still: { from: 'frame' } });
    assert.equal(c.kind, 'video');
    assert.deepEqual(c.proxy, { label: '1080p MP4 (H.264)', detail: '312 MB' });
    assert.deepEqual(c.still, { from: 'frame', formats: [formatById('jpeg'), formatById('png')] });
    assert.deepEqual(c.formats, []);
    assert.deepEqual(c.sizes, []);
    assert.equal(c.original.detail, 'MOV · 3.7 GB');

    const plain = downloadChoices(clip(), { still: { from: 'cover' } });
    assert.equal(plain.proxy, null, 'no proxy: not offered');
    assert.equal(plain.still.from, 'cover');
    assert.equal(downloadChoices(clip(), { proxy: { available: false } }).proxy, null);
  });

  test('a video with no proxy and nothing to take a still from gets the original alone', () => {
    const c = downloadChoices(clip(), {});
    assert.equal(c.reason, 'nothing');
    assert.equal(offersDownloadAs(clip()), false);
    assert.equal(offersDownloadAs(clip(), { proxy: { available: true } }), true);
    assert.equal(offersDownloadAs(clip(), { still: { from: 'cover' } }), true);
    assert.equal(offersDownloadAs(clip(), { still: { from: 'elsewhere' } }), false);
  });

  test('a proxy is named for the lines it has: 1080 at most, the master’s own below that', () => {
    assert.equal(proxyHeight(clip()), 1080);
    assert.equal(proxyHeight(clip({ metadata: { width: 1280, height: 720 } })), 720);
    assert.equal(proxyHeight(clip({ metadata: { width: 1279, height: 719 } })), 718, 'even, as H.264 needs');
    assert.equal(proxyHeight(clip({ metadata: {} })), 1080);
    assert.equal(downloadChoices(clip({ metadata: { height: 720 } }), { proxy: { available: true } }).proxy.label, '720p MP4 (H.264)');
    assert.equal(downloadChoices(clip(), { proxy: { available: true } }).proxy.detail, 'Made for streaming', 'size unknown');
  });

  test('a clip stored as "other" before kinds were worked out is still a video', () => {
    const old = clip({ kind: 'other' });
    assert.equal(downloadChoices(old, { still: { from: 'cover' } }).kind, 'video');
  });

  test('sound, documents and everything else: the original alone', () => {
    for (const f of [
      { name: 'Mix.wav', mime: 'audio/wav', kind: 'audio', size: 1e7 },
      { name: 'Brief.pdf', mime: 'application/pdf', kind: 'doc', size: 1e6 },
      { name: 'Project.zip', mime: 'application/zip', kind: 'other', size: 1e6 },
    ]) {
      const c = downloadChoices(f, { proxy: { available: true }, still: { from: 'cover' }, encoders: { webp: true } });
      assert.equal(c.reason, 'kind', f.name);
      assert.equal(c.proxy, null, f.name);
      assert.equal(c.still, null, f.name);
      assert.equal(offersDownloadAs(f, { proxy: { available: true }, still: { from: 'cover' } }), false, f.name);
    }
  });
});

describe('how big a copy comes out', () => {
  test('the long edge as asked, the aspect kept', () => {
    assert.deepEqual(targetSize({ width: 4032, height: 3024 }, 1920), { width: 1920, height: 1440 });
    assert.deepEqual(targetSize({ width: 3024, height: 4032 }, 1920), { width: 1440, height: 1920 });
    assert.deepEqual(targetSize({ width: 6000, height: 4000 }, 3840), { width: 3840, height: 2560 });
    assert.deepEqual(targetSize({ width: 1000, height: 333 }, 100), { width: 100, height: 33 });
    const t = targetSize({ width: 5184, height: 3456 }, 1080);
    assert.equal(Math.max(t.width, t.height), 1080);
    assert.ok(Math.abs(t.width / t.height - 5184 / 3456) < 0.01);
  });

  test('never larger than the picture: at or past its long edge is its full size', () => {
    assert.deepEqual(targetSize({ width: 800, height: 600 }, 1920), { width: 800, height: 600 });
    assert.deepEqual(targetSize({ width: 1920, height: 1080 }, 1920), { width: 1920, height: 1080 });
    assert.deepEqual(targetSize({ width: 800, height: 600 }, null), { width: 800, height: 600 });
    assert.deepEqual(targetSize({ width: 800, height: 600 }), { width: 800, height: 600 });
    assert.deepEqual(targetSize({ width: 800, height: 600 }, 0), { width: 800, height: 600 });
    assert.deepEqual(targetSize({ width: 800, height: 600 }, 'big'), { width: 800, height: 600 });
  });

  test('a sliver keeps a pixel; no dimensions, no size', () => {
    assert.deepEqual(targetSize({ width: 3000, height: 1 }, 1080), { width: 1080, height: 1 });
    assert.equal(targetSize({ width: 0, height: 10 }, 100), null);
    assert.equal(targetSize(null, 100), null);
    assert.equal(targetSize({ width: 'x', height: 10 }, 100), null);
  });

  test('a camera’s sideways photo is sized as it is shown: EXIF-rotated dimensions', () => {
    // Stored 4032 × 3024, orientation 6 (a quarter clockwise): shown portrait.
    const shown = orientedSize({ width: 4032, height: 3024 }, 6);
    assert.deepEqual(shown, { width: 3024, height: 4032 });
    assert.deepEqual(targetSize(shown, 1920), { width: 1440, height: 1920 });
    for (const o of [5, 6, 7, 8]) assert.deepEqual(orientedSize({ width: 40, height: 30 }, o), { width: 30, height: 40 }, `orientation ${o}`);
    for (const o of [1, 2, 3, 4]) assert.deepEqual(orientedSize({ width: 40, height: 30 }, o), { width: 40, height: 30 }, `orientation ${o}`);
    // The long edge is the same either way up, so the sizes offered are too.
    assert.deepEqual(ids(sizeChoices(shown)), ids(sizeChoices({ width: 4032, height: 3024 })));
  });

  test('the size on record is the row’s width and height, when both are sane', () => {
    assert.deepEqual(recordedSize(photo()), { width: 4032, height: 3024 });
    assert.equal(recordedSize(photo({ metadata: { width: 10 } })), null);
    assert.equal(recordedSize(photo({ metadata: null })), null);
    assert.equal(recordedSize({}), null);
  });
});

describe('what a copy is called', () => {
  test('the extension swapped, and the size said when it is smaller', () => {
    assert.equal(downloadName('IMG_0001.HEIC', { ext: 'jpg', suffix: '1920 px' }), 'IMG_0001 (1920 px).jpg');
    assert.equal(downloadName('IMG_0001.HEIC', { ext: 'png' }), 'IMG_0001.png');
    assert.equal(downloadName('Take 2.final.MOV', { ext: 'mp4', suffix: '1080p' }), 'Take 2.final (1080p).mp4');
    assert.equal(downloadName('README', { ext: 'png' }), 'README.png');
    assert.equal(downloadName('Notes.txt'), 'Notes.txt', 'no new extension: the old one kept');
    const src = { width: 4032, height: 3024 };
    assert.equal(imageDownloadName('Beach.HEIC', { format: 'jpeg', size: { width: 1920, height: 1440 }, source: src }), 'Beach (1920 px).jpg');
    assert.equal(imageDownloadName('Beach.HEIC', { format: 'webp', size: src, source: src }), 'Beach.webp');
    assert.equal(imageDownloadName('Beach.HEIC', { format: formatById('png'), size: { width: 1080, height: 810 }, source: src }), 'Beach (1080 px).png');
    // Asked for a size larger than it came: the full size, and named so.
    assert.equal(imageDownloadName('Small.png', { format: 'jpeg', size: { width: 900, height: 600 }, source: { width: 900, height: 600 } }), 'Small.jpg');
    // Planned before the picture was measured: the size asked for.
    assert.equal(imageDownloadName('Beach.HEIC', { format: 'jpeg', size: { longEdge: 1920, width: null, height: null } }), 'Beach (1920 px).jpg');
    assert.equal(imageDownloadName('Beach.HEIC', { format: 'jpeg', size: { longEdge: null, width: null, height: null } }), 'Beach.jpg');
  });

  test('a video’s proxy, cover and frames', () => {
    assert.equal(proxyDownloadName('Master.mov'), 'Master (1080p).mp4');
    assert.equal(proxyDownloadName('Master.mov', { height: 720 }), 'Master (720p).mp4');
    assert.equal(coverDownloadName('Master.mov', { ext: 'webp' }), 'Master (cover).webp');
    assert.equal(coverDownloadName('Master.mov'), 'Master (cover).jpg');
    // 12.5s at 25fps is frame 312; the camera started at 01:00:00:00.
    assert.equal(
      frameDownloadName('Interview A.mov', { format: 'png', seconds: 12.5, metadata: { fps: { num: 25, den: 1 }, tcStart: 90000 } }),
      'Interview A (01.00.12.12).png',
    );
    // Drop-frame's `;` is no more welcome in a name than `:`. Frame 1800 of a
    // 29.97 clip is the first of minute one, where ;00 and ;01 are dropped.
    assert.equal(
      frameDownloadName('Game.mp4', { format: 'jpeg', seconds: 60.07, metadata: { fps: { num: 30000, den: 1001 }, dropFrame: true } }),
      'Game (00.01.00.02).jpg',
    );
    // No rate on record: the player's assumed 30.
    assert.equal(frameDownloadName('Clip.mp4', { format: 'jpeg', seconds: 1 }), 'Clip (00.00.01.00).jpg');
  });

  test('no separators, reserved or control characters, and no direction tricks', () => {
    assert.equal(downloadName('a/b\\c:d*e?f"g<h>i|j.png', { ext: 'jpg' }), 'a-b-c-d-e-f-g-h-i-j.jpg');
    assert.equal(downloadName('tab\there\nnew.png', { ext: 'jpg' }), 'tab-here-new.jpg');
    const trick = downloadName('Invoice‮gpj.exe.png', { ext: 'jpg' });
    assert.equal(trick, 'Invoicegpj.exe.jpg');
    assert.ok(!/[‪-‮⁦-⁩]/.test(trick));
    assert.equal(downloadName('CON.png', { ext: 'jpg' }), 'CON_.jpg');
    assert.equal(downloadName('lpt1.png', { ext: 'jpg' }), 'lpt1_.jpg');
    assert.equal(downloadName('clip.mov', { ext: 'mp4', suffix: 'at 01:02' }), 'clip (at 01-02).mp4');
    assert.equal(sanitizeFilename('  spaced   out  '), 'spaced out');
  });

  test('never a hidden file, never an empty name', () => {
    assert.equal(downloadName('.hidden.png', { ext: 'jpg' }), 'hidden.jpg');
    assert.equal(downloadName('...png', { ext: 'jpg' }), 'Download.jpg');
    assert.equal(downloadName('   .png', { ext: 'jpg' }), 'Download.jpg');
    assert.equal(downloadName('', { ext: 'jpg' }), 'Download.jpg');
    assert.equal(downloadName(null, { ext: 'mp4', suffix: '1080p' }), 'Download (1080p).mp4');
    assert.equal(downloadName('name.', { ext: 'jpg' }), 'name.jpg', 'a trailing dot goes');
    assert.deepEqual(splitName('.env'), { base: '.env', ext: '' });
    assert.deepEqual(splitName('archive.tar.gz'), { base: 'archive.tar', ext: 'gz' });
  });

  test('a long name is cut to fit, never through a character, the suffix and extension whole', () => {
    const long = `${'é'.repeat(300)}.HEIC`;
    const out = downloadName(long, { ext: 'jpg', suffix: '1920 px' });
    assert.ok(new TextEncoder().encode(out).length <= 200, `${new TextEncoder().encode(out).length} bytes`);
    assert.ok(out.endsWith(' (1920 px).jpg'));
    assert.ok(out.startsWith('éé'));
    assert.ok(!out.includes('�'));
    const emoji = downloadName(`${'📷'.repeat(100)}.png`, { ext: 'webp' });
    assert.ok(new TextEncoder().encode(emoji).length <= 200);
    assert.equal([...emoji.replace(/\.webp$/, '')].every((ch) => ch === '📷'), true, 'no half an emoji');
  });

  test('an extension is letters and digits only', () => {
    assert.equal(downloadName('a.png', { ext: 'j/p:g' }), 'a.jpg');
    assert.equal(downloadName('a.png', { ext: '' }), 'a');
  });
});

describe('which download a route is asked for', () => {
  test('nothing, empty or "original" is the original; the variants by name; anything else refused', () => {
    assert.deepEqual(DOWNLOAD_VARIANTS, ['proxy', 'poster']);
    for (const v of [null, undefined, '', 'original']) assert.deepEqual(parseDownloadVariant(v), { variant: null }, String(v));
    assert.deepEqual(parseDownloadVariant('proxy'), { variant: 'proxy' });
    assert.deepEqual(parseDownloadVariant('poster'), { variant: 'poster' });
    for (const v of ['PROXY', 'thumb', '../proxy', 'proxy ', '_thumbs/x.proxy.mp4']) {
      assert.ok(parseDownloadVariant(v).error, v);
    }
  });

  test('a stored cover’s format from its signed address, so one already in the format asked for is saved as it is', () => {
    const u = (key) => `https://s3.test/onyx/${key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc`;
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    assert.equal(storedCoverFormat(u(`_thumbs/${id}.poster.jpg`)), 'jpeg');
    assert.equal(storedCoverFormat(u(`_thumbs/${id}.poster.webp`)), 'webp');
    assert.equal(storedCoverFormat(u(`_thumbs/${id}.jpg`)), 'jpeg', 'a small clip’s cover is its thumbnail');
    assert.equal(storedCoverFormat(`https://cdn.test/_thumbs/${id}.webp`), 'webp');
    assert.equal(storedCoverFormat(u(`_thumbs/${id}.sm.webp`)), null);
    assert.equal(storedCoverFormat(u('team/Cuts/abc-thumb-clip.jpg')), null, 'a legacy thumbnail: converted instead');
    assert.equal(storedCoverFormat('not a url'), null);
    assert.equal(storedCoverFormat(null), null);
  });
});
