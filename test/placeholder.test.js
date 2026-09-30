// A thumbnail's placeholder (lib/placeholder.js): the tiny copy a tile shows
// until its thumbnail loads — what may be stored, and where it goes with its
// thumbnail.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { placeholderFacts, placeholderSize, compactPlaceholder, PLACEHOLDER_EDGE, PLACEHOLDER_MAX_CHARS } from '../lib/placeholder.js';
import { uploadFields, sharedFile, MEDIA_KEYS } from '../lib/media.js';
import { withoutTakenPreviews } from '../lib/preview-gc.js';

// A real 24×18 WebP, as a browser's canvas makes one.
const WEBP = 'data:image/webp;base64,UklGRkQAAABXRUJQVlA4IDgAAAAQAwCdASoYABIAPtFiqk+oJaOiKAgBABoJZQDKABanFAAA/uX6P+HPtj97JX/VR2OO4YxZAAAAAA==';
// A JPEG's first bytes are all that is checked.
const JPEG = `data:image/jpeg;base64,${btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46))}`;
const KEY = '_thumbs/0f8fad5b-d9cb-469f-a165-70867728950e.webp';

describe('what a placeholder is', () => {
  test('a WebP or a JPEG, as a data URL, whose bytes are that format', () => {
    assert.equal(placeholderFacts(WEBP), WEBP);
    assert.equal(placeholderFacts(JPEG), JPEG);
  });

  test('nothing else an <img> would take: not SVG, PNG, a URL, or a mislabelled format', () => {
    const svg = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>')}`;
    const png = `data:image/png;base64,${btoa('\x89PNG\r\n\x1a\n')}`;
    for (const bad of [
      svg, png, 'https://evil.test/p.webp', WEBP.replace('image/webp', 'image/jpeg'), JPEG.replace('image/jpeg', 'image/webp'),
      'data:image/webp;base64,', 'data:image/webp;base64,@@@', `${WEBP} `, null, 7, {},
      `data:image/webp;base64,${'A'.repeat(PLACEHOLDER_MAX_CHARS)}`,
    ]) {
      assert.equal(placeholderFacts(bad), null, String(bad).slice(0, 40));
    }
  });

  test('a canvas’s colour profile is taken off, whoever made it, and the picture kept as it was', () => {
    const le32 = (n) => String.fromCharCode(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
    const bytes = atob(WEBP.split(',')[1]);
    const vp8 = bytes.slice(12);
    const chunk = (id, data) => id + le32(data.length) + data + (data.length & 1 ? '\0' : '');
    const body = `WEBP${chunk('VP8X', '\x20' + '\0'.repeat(9))}${chunk('ICCP', 'p'.repeat(456))}${vp8}`;
    const wrapped = `data:image/webp;base64,${btoa(`RIFF${le32(body.length)}${body}`)}`;
    assert.equal(compactPlaceholder(wrapped), WEBP, 'the simple form, byte for byte');
    assert.equal(placeholderFacts(wrapped), WEBP, 'what is stored');
    assert.ok(wrapped.length > 3 * WEBP.length);

    const seg = (marker, data) => `\xff${String.fromCharCode(marker)}${String.fromCharCode((data.length + 2) >> 8, (data.length + 2) & 0xff)}${data}`;
    const scan = '\xff\xda\0\x08rest-of-scan\xff\xd9';
    const jfif = seg(0xe0, 'JFIF\0\x01\x01\0\0\x01\0\x01\0\0');
    const icc = seg(0xe2, `ICC_PROFILE\0${'c'.repeat(600)}`);
    const jpeg = (...parts) => `data:image/jpeg;base64,${btoa(`\xff\xd8${parts.join('')}`)}`;
    assert.equal(compactPlaceholder(jpeg(jfif, icc, scan)), jpeg(jfif, scan), 'APP2 gone, JFIF and the scan kept');
    assert.equal(compactPlaceholder('data:image/webp;base64,@@'), 'data:image/webp;base64,@@', 'what it does not read, it leaves');
  });

  test('its size: the long side PLACEHOLDER_EDGE, the shape kept', () => {
    assert.deepEqual(placeholderSize({ width: 4000, height: 3000 }), { width: PLACEHOLDER_EDGE, height: 18 });
    assert.deepEqual(placeholderSize({ width: 1080, height: 1920 }), { width: 14, height: PLACEHOLDER_EDGE });
    assert.deepEqual(placeholderSize({ width: 10000, height: 10 }), { width: PLACEHOLDER_EDGE, height: 1 });
    assert.equal(placeholderSize({ width: 0, height: 10 }), null);
    assert.equal(placeholderSize(null), null);
  });
});

describe('where it goes', () => {
  test('an upload keeps one only beside the thumbnail it copies, and never from metadata as sent', () => {
    assert.ok(MEDIA_KEYS.includes('placeholder'));
    assert.equal(uploadFields({ name: 'a.jpg', mime: 'image/jpeg', thumbnailKey: KEY, placeholder: WEBP }).metadata.placeholder, WEBP);
    assert.equal(uploadFields({ name: 'a.jpg', mime: 'image/jpeg', placeholder: WEBP }).metadata.placeholder, undefined, 'no thumbnail, no placeholder');
    assert.equal(uploadFields({ name: 'a.jpg', thumbnailKey: KEY, metadata: { placeholder: WEBP } }).metadata.placeholder, undefined);
    assert.equal(uploadFields({ name: 'a.jpg', thumbnailKey: KEY, placeholder: 'data:image/svg+xml;base64,PHN2Zz4=' }).metadata.placeholder, undefined);
  });

  test('a thumbnail another row holds is dropped, and its placeholder with it', () => {
    const fields = { thumbnailKey: KEY, posterKey: null, thumbSizes: ['sm'], metadata: { placeholder: WEBP, width: 10 } };
    const out = withoutTakenPreviews(fields, new Set([KEY]));
    assert.equal(out.thumbnailKey, null);
    assert.deepEqual(out.metadata, { width: 10 });
  });

  test('a share link hands it out with the picture it stands in for', () => {
    assert.equal(sharedFile({ id: 'f', metadata: { placeholder: WEBP, client: 'Acme' } }).metadata.placeholder, WEBP);
  });
});
