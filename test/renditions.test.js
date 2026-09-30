// Which picture each surface asks for. The failure here is silent: a list of
// 44px rows pulling 864px posters (102x the pixels), or a card on a 2x screen
// shown a soft one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { thumbSources, stageSources, smallOriginal, pictureOrigins, CARD_SIZES_DEFAULT } from '../lib/renditions.js';
import { gridPosterSize, smPosterSize, coverWidth } from '../lib/poster.js';

const photo = {
  id: '1', name: 'DSC.jpg', mime: 'image/jpeg', size: 9_000_000, url: 'https://s3/orig',
  thumbnailUrl: 'https://s3/grid', smUrl: 'https://s3/sm', xsUrl: 'https://s3/xs', posterUrl: 'https://s3/preview',
  thumbSizes: ['sm', 'xs'], metadata: { width: 6000, height: 4000 },
};

describe('card', () => {
  test('a srcset of sm and the grid poster, described by the 4:3 card each covers', () => {
    const s = thumbSources(photo, 'card', { sizes: 207 });
    assert.equal(s.src, photo.thumbnailUrl);
    // 3:2 source: sm 576x384 covers a 512-wide card; grid 864x576 a 768-wide one.
    assert.equal(s.srcSet, 'https://s3/sm 512w, https://s3/grid 768w');
    assert.equal(s.sizes, '207px');
  });

  test('before the grid is measured, the default sizes', () => {
    assert.equal(thumbSources(photo, 'card').sizes, CARD_SIZES_DEFAULT);
  });

  test('the descriptors are what the generator drew', () => {
    const d = { width: 6000, height: 4000 };
    assert.equal(coverWidth(smPosterSize(d)), 512);
    assert.equal(coverWidth(gridPosterSize(d)), 768);
    // Portrait: the width limits.
    const p = { width: 3000, height: 4000 };
    assert.equal(coverWidth(smPosterSize(p)), 512);
    assert.equal(coverWidth(gridPosterSize(p)), 768);
  });

  test('without recorded dimensions there is nothing to describe: the grid poster alone', () => {
    const s = thumbSources({ ...photo, metadata: {} }, 'card');
    assert.deepEqual(s, { src: photo.thumbnailUrl });
  });

  test('without an sm sibling, the grid poster alone', () => {
    assert.deepEqual(thumbSources({ ...photo, thumbSizes: [] }, 'card'), { src: photo.thumbnailUrl });
    // A URL without the size listed is not trusted to exist.
    assert.deepEqual(thumbSources({ ...photo, thumbSizes: ['xs'] }, 'card'), { src: photo.thumbnailUrl });
  });

  test('an sm that failed to load falls back to the grid poster', () => {
    assert.deepEqual(thumbSources(photo, 'card', { failed: new Set([photo.smUrl]) }), { src: photo.thumbnailUrl });
  });

  test('a dead grid poster falls back to a small original, then to nothing', () => {
    const small = { ...photo, size: 2_000_000, thumbSizes: [] };
    assert.deepEqual(thumbSources(small, 'card', { failed: new Set([small.thumbnailUrl]) }), { src: small.url });
    assert.deepEqual(thumbSources(photo, 'card', { failed: new Set([photo.thumbnailUrl, photo.smUrl]) }), { src: null });
  });

  test('a video never falls back to its original', () => {
    const clip = { name: 'a.mp4', mime: 'video/mp4', size: 1000, url: 'https://s3/clip', thumbnailUrl: null };
    assert.deepEqual(thumbSources(clip, 'card'), { src: null });
  });
});

describe('small surfaces', () => {
  test('a list row, the palette and the storage pages take xs', () => {
    for (const surface of ['row', 'palette', 'storage']) {
      assert.deepEqual(thumbSources(photo, surface), { src: photo.xsUrl }, surface);
    }
  });

  test('without xs, the next smallest', () => {
    assert.deepEqual(thumbSources({ ...photo, thumbSizes: ['sm'] }, 'row'), { src: photo.smUrl });
    assert.deepEqual(thumbSources({ ...photo, thumbSizes: [] }, 'row'), { src: photo.thumbnailUrl });
  });

  test('an original stands in on a row only when it is under a megabyte', () => {
    const bare = { ...photo, thumbnailUrl: null, thumbSizes: [] };
    assert.deepEqual(thumbSources({ ...bare, size: 900_000 }, 'row'), { src: bare.url });
    assert.deepEqual(thumbSources({ ...bare, size: 3_000_000 }, 'row'), { src: null });
    assert.equal(smallOriginal({ ...bare, size: 3_000_000 }, 'card'), bare.url, 'a card still takes one up to 8 MB');
  });

  test('Get info takes sm', () => {
    assert.deepEqual(thumbSources(photo, 'info'), { src: photo.smUrl });
    assert.deepEqual(thumbSources({ ...photo, thumbSizes: [] }, 'info'), { src: photo.thumbnailUrl });
  });
});

describe('stage', () => {
  test('thumbnail, preview, original', () => {
    assert.deepEqual(stageSources(photo), { thumb: photo.thumbnailUrl, preview: photo.posterUrl, original: photo.url });
  });
  test('a video has no original layer: the player owns it', () => {
    const clip = { name: 'a.mp4', mime: 'video/mp4', url: 'https://s3/clip', thumbnailUrl: 'g', posterUrl: 'p' };
    assert.deepEqual(stageSources(clip), { thumb: 'g', preview: 'p', original: null });
  });
  test('a HEIC original is a layer only where the probe passed', () => {
    const heic = { name: 'a.heic', mime: 'image/heic', url: 'https://s3/heic', thumbnailUrl: null };
    assert.equal(stageSources(heic).original, null);
    assert.equal(stageSources(heic, { probe: { heic: true } }).original, heic.url);
  });
});

describe('where the pictures come from', () => {
  const B2 = 'https://s3.us-west-004.backblazeb2.com';

  test('the origins alone, the most used first: never a path, never a signature', () => {
    const urls = [
      `${B2}/onyx/_thumbs/a.webp?X-Amz-Signature=secret`,
      'https://drive.example.com/team/A001.jpg?X-Amz-Signature=other',
      `${B2}/onyx/_thumbs/b.sm.webp?X-Amz-Signature=secret2`,
      `${B2}/onyx/_thumbs/c.webp`,
    ];
    assert.deepEqual(pictureOrigins(urls), [B2, 'https://drive.example.com']);
    assert.ok(!pictureOrigins(urls).join(' ').includes('Signature'));
  });

  test('at most `max`, and only http(s): no placeholder data, no blob, nothing unparseable', () => {
    const urls = ['https://a.example/x', 'https://a.example/y', 'https://b.example/x', 'https://c.example/x'];
    assert.deepEqual(pictureOrigins(urls), ['https://a.example', 'https://b.example']);
    assert.deepEqual(pictureOrigins(urls, { max: 1 }), ['https://a.example']);
    assert.deepEqual(pictureOrigins(['data:image/webp;base64,AAAA', 'blob:https://app/x', '/relative.jpg', 'nonsense', null, undefined, 7]), []);
    assert.deepEqual(pictureOrigins(null), []);
    assert.deepEqual(pictureOrigins(['http://127.0.0.1:59000/onyx/_thumbs/a.webp']), ['http://127.0.0.1:59000']);
  });

  test('a listing gives the bucket its tiles are drawn from, and a drive’s own for a small original', () => {
    const rows = [
      { ...photo, id: '2', thumbnailUrl: `${B2}/onyx/_thumbs/g.webp?s=1`, smUrl: `${B2}/onyx/_thumbs/g.sm.webp?s=1` },
      { ...photo, id: '3', thumbnailUrl: `${B2}/onyx/_thumbs/h.webp?s=1`, smUrl: `${B2}/onyx/_thumbs/h.sm.webp?s=1` },
      { id: '4', name: 'b.png', mime: 'image/png', size: 1000, url: 'https://drive.example.com/team/b.png?s=2', thumbnailUrl: null },
      { id: '5', name: 'notes.pdf', mime: 'application/pdf', url: 'https://drive.example.com/team/notes.pdf' },
    ];
    assert.deepEqual(pictureOrigins(rows.map((f) => thumbSources(f).src)), [B2, 'https://drive.example.com']);
  });
});

describe('the pages connect to them first', () => {
  const src = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');

  test('the library, a file and a share link each name their pictures; a locked link names none', async () => {
    const files = await src('app/files/page.js');
    assert.match(files, /<PreviewPreconnect urls=\{initial\?\.files\?\.map\(\(f\) => thumbSources\(f\)\.src\)\} \/>/);
    const file = await src('app/files/[id]/page.js');
    assert.match(file, /<PreviewPreconnect urls=\{\[signed\.thumbnailUrl, signed\.posterUrl, signed\.proxyUrl, signed\.url\]\} \/>/);
    const share = await src('app/s/[token]/page.js');
    const at = share.indexOf('<PreviewPreconnect');
    assert.ok(at > share.indexOf("if (access.state === 'ok')"), 'only once the link has let them in');
    assert.ok(at < share.indexOf("if (access.state === 'password'"));
  });

  test('both pools, a DNS lookup, and only origins', async () => {
    const component = await src('app/components/PreviewPreconnect.js');
    assert.ok(!component.includes("'use client'"), 'a server component: the hints go out with the first bytes');
    assert.match(component, /for \(const origin of pictureOrigins\(urls\)\)/);
    assert.match(component, /ReactDOM\.prefetchDNS\?\.\(origin\);/);
    assert.match(component, /ReactDOM\.preconnect\?\.\(origin\);/);
    assert.match(component, /ReactDOM\.preconnect\?\.\(origin, \{ crossOrigin: 'anonymous' \}\);/);
  });
});
