// The server's own previews (lib/server-previews.js), with the real sharp and
// a pretend bucket: what it draws for a picture, that it matches what a
// browser makes (lib/poster.js sizes), and how a run claims, records and
// gives way to a thumbnail someone else made meanwhile.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import {
  drawServerPreviews, runServerPreviews, previewPlan, uprightSize, SERVER_PREVIEW_MAX_BYTES, drawPlaceholder,
} from '../lib/server-previews.js';
import { gridPosterSize } from '../lib/poster.js';
import { placeholderFacts } from '../lib/placeholder.js';

const picture = (width, height, { format = 'jpeg', orientation } = {}) => {
  let img = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } });
  img = format === 'png' ? img.png() : img.jpeg({ quality: 90 });
  if (orientation) img = img.withMetadata({ orientation });
  return img.toBuffer();
};

function fakeIO(bytes) {
  const stored = new Map();
  return {
    sharp,
    stored,
    removed: [],
    async read(_file, path) { await writeFile(path, bytes); },
    async readKey(key, path) { this.read_ = [...(this.read_ || []), key]; await writeFile(path, bytes); },
    async put(key, body, contentType) { stored.set(key, { body, contentType }); },
    async remove(key) { this.removed.push(key); stored.delete(key); },
  };
}

describe('what the server draws', () => {
  test('a big photo: the grid thumbnail, its siblings, the large preview and a placeholder', async () => {
    const io = fakeIO(await picture(6000, 4000));
    const made = await drawServerPreviews({ id: 'f1', size: 20_000_000, mime: 'image/jpeg' }, io);
    assert.match(made.thumbnailKey, /^_thumbs\/[0-9a-f-]{36}\.webp$/);
    assert.match(made.posterKey, /^_thumbs\/[0-9a-f-]{36}\.poster\.webp$/);
    assert.deepEqual(made.sizes, ['sm', 'xs']);
    assert.deepEqual(made.media, { width: 6000, height: 4000 });
    assert.ok(placeholderFacts(made.placeholder), 'a placeholder a browser would have stored');

    const grid = await sharp(io.stored.get(made.thumbnailKey).body).metadata();
    assert.deepEqual({ width: grid.width, height: grid.height }, gridPosterSize({ width: 6000, height: 4000 }), 'the size every client draws');
    assert.equal(grid.format, 'webp');
    const poster = await sharp(io.stored.get(made.posterKey).body).metadata();
    assert.equal(Math.max(poster.width, poster.height), 2400);
    for (const { contentType } of io.stored.values()) assert.equal(contentType, 'image/webp');
  });

  test('a photo taken on its side is drawn upright', async () => {
    const io = fakeIO(await picture(4000, 3000, { orientation: 6 }));
    const made = await drawServerPreviews({ id: 'f2', size: 5_000_000, mime: 'image/jpeg' }, io);
    assert.deepEqual(made.media, { width: 3000, height: 4000 });
    const grid = await sharp(io.stored.get(made.thumbnailKey).body).metadata();
    assert.ok(grid.height > grid.width, 'portrait, as it is shown');
  });

  test('a small PNG: a thumbnail and no needless large preview', async () => {
    const io = fakeIO(await picture(900, 600, { format: 'png' }));
    const made = await drawServerPreviews({ id: 'f3', size: 40_000, mime: 'image/png' }, io);
    assert.equal(made.posterKey, null, 'the original is already about that size');
    assert.ok(io.stored.has(made.thumbnailKey));
  });

  test('what it cannot draw, it says', async () => {
    const io = fakeIO(Buffer.from('not a picture'));
    await assert.rejects(drawServerPreviews({ id: 'f4', size: 13, mime: 'image/png' }, io));
    assert.equal(io.stored.size, 0, 'nothing put for it');
  });

  test('sizes and orientation', () => {
    assert.deepEqual(uprightSize({ width: 10, height: 20, orientation: 8 }), { width: 20, height: 10 });
    assert.equal(uprightSize({}), null);
    assert.ok(previewPlan({ width: 6000, height: 4000 }, { bytes: 1e7, mime: 'image/jpeg' }).preview);
    assert.ok(SERVER_PREVIEW_MAX_BYTES < 512 * 1024 * 1024, 'fits in /tmp');
  });
});

describe('a run', () => {
  const db = (files, { thumbnailed = new Set() } = {}) => {
    const queue = [...files];
    const recorded = new Map();
    const errors = new Map();
    return {
      recorded, errors,
      async claimServerPreviews() { return queue.length ? [queue.shift()] : []; },
      async fileThumbnailKey(id) { return thumbnailed.has(id) ? '_thumbs/theirs.webp' : null; },
      async setFileThumbnail(id, key, media, posterKey, sizes, extra) { recorded.set(id, { key, media, posterKey, sizes, ...extra }); },
      async setServerPreviewError(id, e) { errors.set(id, e); },
    };
  };

  test('draws and records what it claims, until there is nothing left', async () => {
    const io = fakeIO(await picture(3000, 2000));
    const store = db([{ id: 'a', name: 'a.jpg', size: 3e6, mime: 'image/jpeg' }, { id: 'b', name: 'b.jpg', size: 3e6, mime: 'image/jpeg' }]);
    const out = await runServerPreviews({ io, db: store, concurrency: 2 });
    assert.equal(out.drawn, 2);
    assert.match(store.recorded.get('a').key, /^_thumbs\//);
    assert.ok(store.recorded.get('a').placeholder);
    assert.equal(store.errors.get('a'), null);
  });

  test('a thumbnail someone made meanwhile stays, and ours go', async () => {
    const io = fakeIO(await picture(3000, 2000));
    const store = db([{ id: 'a', name: 'a.jpg', size: 3e6, mime: 'image/jpeg' }], { thumbnailed: new Set(['a']) });
    const out = await runServerPreviews({ io, db: store, concurrency: 1 });
    assert.equal(out.kept, 1);
    assert.equal(store.recorded.size, 0);
    assert.equal(io.stored.size, 0, 'every preview it put is removed');
  });

  test('a failure is recorded with its reason, and the run goes on', async () => {
    const io = fakeIO(Buffer.from('broken'));
    const store = db([{ id: 'x', name: 'x.png', size: 6, mime: 'image/png' }]);
    const out = await runServerPreviews({ io, db: store, concurrency: 1 });
    assert.equal(out.failed, 1);
    assert.ok(store.errors.get('x'));
  });
});

describe('placeholders for thumbnails made before them', () => {
  test('cut from the smallest copy there is', async () => {
    const io = fakeIO(await picture(160, 120));
    const placeholder = await drawPlaceholder({ id: 'p', thumbnailKey: '_thumbs/0b5c1d2e-3f40-4a51-8b62-7c83d94ea5f6.webp', thumbSizes: ['sm', 'xs'] }, io);
    assert.ok(placeholderFacts(placeholder));
    assert.deepEqual(io.read_, ['_thumbs/0b5c1d2e-3f40-4a51-8b62-7c83d94ea5f6.xs.webp'], 'a few kilobytes, never the original');
    const small = (await sharp(Buffer.from(placeholder.split(',')[1], 'base64')).metadata());
    assert.equal(Math.max(small.width, small.height), 24);
  });

  test('a run gives them out once there is nothing to draw whole, for the thumbnail they were cut from', async () => {
    const io = fakeIO(await picture(160, 120));
    const set = [];
    let handed = false;
    const store = {
      async claimServerPreviews() { return []; },
      async claimServerPlaceholders() { if (handed) return []; handed = true; return [{ id: 'q', thumbnailKey: '_thumbs/0b5d.webp', thumbSizes: [] }]; },
      async setFilePlaceholder(id, placeholder, { thumbnailKey }) { set.push({ id, thumbnailKey, ok: !!placeholderFacts(placeholder) }); return {}; },
      async setServerPreviewError() {},
    };
    const out = await runServerPreviews({ io, db: store, concurrency: 1 });
    assert.equal(out.placeholders, 1);
    assert.deepEqual(set, [{ id: 'q', thumbnailKey: '_thumbs/0b5d.webp', ok: true }]);
  });
});
