// Which picture each surface asks for. The failure here is silent: a list of
// 44px rows pulling 864px posters (102x the pixels), or a card on a 2x screen
// shown a soft one.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { thumbSources, stageSources, smallOriginal, CARD_SIZES_DEFAULT } from '../lib/renditions.js';
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
