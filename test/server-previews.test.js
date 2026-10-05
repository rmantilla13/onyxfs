// The server's own previews (lib/server-previews.js), with the real sharp and
// a pretend bucket: what it draws for a picture, that it matches what a
// browser makes (lib/poster.js sizes), and how a run claims, records and
// gives way to a thumbnail someone else made meanwhile.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import {
  drawServerPreviews, drawServerPoster, runServerPreviews, previewPlan, uprightSize, SERVER_PREVIEW_MAX_BYTES, MAX_INPUT_PIXELS,
  drawPlaceholder, decodedBytes, HEAVY_DECODE_BYTES, clearStaleTmp,
} from '../lib/server-previews.js';
import { gridPosterSize, imagePreviewFor } from '../lib/poster.js';
import { placeholderFacts } from '../lib/placeholder.js';

const picture = (width, height, { format = 'jpeg', orientation } = {}) => {
  let img = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } });
  img = format === 'png' ? img.png() : img.jpeg({ quality: 90 });
  if (orientation) img = img.withMetadata({ orientation });
  return img.toBuffer();
};

// A PNG whose header says `width` x `height`, with no pixels behind it: all
// sharp reads before it would decode, which is all a size limit needs.
const pngHeader = (width, height) => {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bits a channel
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(1))), chunk('IEND', Buffer.alloc(0)),
  ]);
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

  test('what a picture comes to decoded whole, which is what memory holds, not its pixels', () => {
    assert.equal(decodedBytes({ width: 16384, height: 16384, channels: 3, depth: 'uchar' }), 16384 * 16384 * 3);
    assert.equal(decodedBytes({ width: 16384, height: 16384, channels: 3, depth: 'ushort' }), 16384 * 16384 * 6);
    assert.equal(decodedBytes({ width: 100, height: 100, channels: 4, depth: 'float' }), 160_000);
    assert.ok(decodedBytes({ width: 6000, height: 4000, channels: 3, depth: 'uchar' }) < HEAVY_DECODE_BYTES, 'a camera’s photo is drawn beside another');
    assert.ok(decodedBytes({ width: 16384, height: 16384, channels: 3, depth: 'ushort' }) > HEAVY_DECODE_BYTES, 'one near the limit in 16 bits waits its turn');
  });

  test('too many pixels: refused on its header, before any decode, with its size', async () => {
    const io = fakeIO(pngHeader(20000, 20000));
    const e = await drawServerPoster({ id: 'big', name: 'big.png', size: 5_000_000, mime: 'image/png' }, io).catch((err) => err);
    assert.equal(e.message, 'Too many pixels to draw on the server.');
    assert.deepEqual(e.source, { width: 20000, height: 20000 });
    await assert.rejects(drawServerPreviews({ id: 'big', size: 5_000_000, mime: 'image/png' }, io), /Too many pixels/);
    assert.equal(io.stored.size, 0);
  });
});

describe('a run', () => {
  const db = (files, { thumbnailed = new Set() } = {}) => {
    const queue = [...files];
    const recorded = new Map();
    const errors = new Map();
    const drawn = new Set();
    return {
      recorded, errors, drawn,
      async claimServerPreviews() { return queue.length ? [queue.shift()] : []; },
      async fileThumbnailKey(id) { return thumbnailed.has(id) ? '_thumbs/theirs.webp' : null; },
      async setFileThumbnail(id, key, media, posterKey, sizes, extra) { recorded.set(id, { key, media, posterKey, sizes, ...extra }); },
      async setServerPreviewError(id, e) { errors.set(id, e); },
      async setServerPreviewDrawn(id) { errors.set(id, null); drawn.add(id); },
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
    assert.deepEqual([...store.drawn].sort(), ['a', 'b'], 'their tries handed back');
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

describe('the large preview alone, for a picture whose thumbnail stands', () => {
  const THUMB = '_thumbs/0b5c1d2e-3f40-4a51-8b62-7c83d94ea5f6.webp';
  // A row as claimServerPosters hands it: a thumbnail, its siblings and
  // placeholder, and no large preview.
  const row = (id, over = {}) => ({
    id, name: `${id}.jpg`, size: 20_000_000, mime: 'image/jpeg', thumbnailKey: THUMB, thumbSizes: ['sm', 'xs'],
    posterKey: null, metadata: { placeholder: 'data:image/webp;base64,AAAA' }, ...over,
  });

  // The three queues a run takes from, in the order it is to take them, and
  // everything it records, as it happens. A claim hands over what fits in
  // the room it is given, as lib/db.js's do. `broken` is a database that
  // fails as a preview is recorded; `lost`, one that records it and fails
  // to say so.
  const db = ({ whole = [], placeholders = [], posters = [], theirs = new Set(), broken = false, lost = false } = {}) => {
    const queues = { whole: [...whole], placeholders: [...placeholders], posters: [...posters] };
    const log = [];
    const errors = new Map();
    const take = (q, n = 1, maxBytes = Infinity) => {
      const fits = queues[q].filter((f) => !(f.size > maxBytes)).slice(0, n);
      queues[q] = queues[q].filter((f) => !fits.includes(f));
      return fits;
    };
    return {
      log, errors, claimed: [], drawn: [],
      async claimServerPreviews({ maxBytes }) { return take('whole', 1, maxBytes); },
      async claimServerPlaceholders() { return take('placeholders', 4); },
      async claimServerPosters(args) { this.claimed.push(args); return take('posters', 1, args.maxBytes); },
      async fileThumbnailKey() { return null; },
      async setFileThumbnail(id) { log.push(['thumbnail', id]); },
      async setFilePlaceholder(id) { log.push(['placeholder', id]); return {}; },
      async setServerPoster(id, posterKey, media, { thumbnailKey }) {
        if (broken && posterKey) throw new Error('The database went away.');
        log.push(['poster', id, posterKey, media, thumbnailKey]);
        if (lost && posterKey) throw new Error('The connection dropped.');
        return !theirs.has(id);
      },
      async unreferencedPreviewKeys({ posterKeys = [] }) {
        return posterKeys.filter((k) => !log.some(([what, , key]) => what === 'poster' && key === k));
      },
      async setServerPreviewError(id, e) { errors.set(id, e); },
      async setServerPreviewDrawn(id) { errors.set(id, null); this.drawn.push(id); },
    };
  };

  test('drawn upright, at the size every client draws it, and nothing else', async () => {
    const io = fakeIO(await picture(4000, 3000, { orientation: 6 }));
    const made = await drawServerPoster(row('a'), io);
    assert.match(made.posterKey, /^_thumbs\/[0-9a-f-]{36}\.poster\.webp$/);
    assert.deepEqual(made.media, { width: 3000, height: 4000 });
    assert.deepEqual([...io.stored.keys()], [made.posterKey], 'no thumbnail, siblings or placeholder');
    const poster = await sharp(io.stored.get(made.posterKey).body).metadata();
    assert.equal(poster.format, 'webp');
    assert.deepEqual({ width: poster.width, height: poster.height }, imagePreviewFor({ width: 3000, height: 4000 }, { bytes: 20e6, mime: 'image/jpeg' }));
  });

  test('a picture that turns out to need none: its size, and nothing put', async () => {
    const io = fakeIO(await picture(900, 600));
    assert.deepEqual(await drawServerPoster(row('b', { size: 300_000 }), io), { posterKey: null, media: { width: 900, height: 600 } });
    const gif = fakeIO(await picture(4000, 3000, { format: 'png' }));
    assert.equal((await drawServerPoster(row('c', { name: 'c.gif', mime: '' }), gif)).posterKey, null, 'a GIF, known by its name');
    assert.equal(io.stored.size + gif.stored.size, 0);
  });

  test('a run records it for the thumbnail it was claimed with, and leaves the rest of the row alone', async () => {
    const io = fakeIO(await picture(6000, 4000));
    const store = db({ posters: [row('p')] });
    const out = await runServerPreviews({ io, db: store, concurrency: 1 });
    assert.equal(out.posters, 1);
    assert.equal(out.drawn, 0);
    assert.equal(store.log.length, 1, 'no thumbnail, siblings or placeholder recorded');
    const [what, id, posterKey, media, thumbnailKey] = store.log[0];
    assert.deepEqual([what, id, thumbnailKey], ['poster', 'p', THUMB]);
    assert.deepEqual(media, { width: 6000, height: 4000 });
    assert.deepEqual([...io.stored.keys()], [posterKey]);
    assert.equal(store.errors.get('p'), null);
    assert.deepEqual(store.drawn, ['p'], 'its tries handed back');
    assert.deepEqual(store.claimed[0], { limit: 1, maxBytes: SERVER_PREVIEW_MAX_BYTES, maxPixels: MAX_INPUT_PIXELS });
  });

  test('one that needs none after all: its size, read upright, recorded, and its tries left as they are', async () => {
    const io = fakeIO(await picture(900, 600));
    const store = db({ posters: [row('n', { size: 300_000 })] });
    const out = await runServerPreviews({ io, db: store, concurrency: 1 });
    assert.deepEqual(store.log, [['poster', 'n', null, { width: 900, height: 600 }, THUMB]]);
    assert.deepEqual({ posters: out.posters, failed: out.failed }, { posters: 0, failed: 0 });
    assert.deepEqual(store.drawn, [], 'a claim and a draw that disagree run out of tries, not round for ever');
    assert.equal(io.stored.size, 0);
  });

  test('too many pixels and no size on record: the size is recorded, so the next claim leaves it out', async () => {
    const io = fakeIO(pngHeader(20000, 20000));
    const store = db({ posters: [row('h', { name: 'h.png', mime: 'image/png' })] });
    const out = await runServerPreviews({ io, db: store, concurrency: 1 });
    assert.equal(out.failed, 1);
    assert.deepEqual(store.log, [['poster', 'h', null, { width: 20000, height: 20000 }, THUMB]]);
    assert.equal(store.errors.get('h'), 'Too many pixels to draw on the server.');
  });

  test('the database failing once the preview is put: the preview goes, and the failure is recorded', async () => {
    const io = fakeIO(await picture(6000, 4000));
    const store = db({ posters: [row('d')], broken: true });
    const out = await runServerPreviews({ io, db: store, concurrency: 1 });
    assert.equal(out.failed, 1);
    assert.equal(io.removed.length, 1);
    assert.equal(io.stored.size, 0, 'nothing left in the bucket that no row holds');
    assert.equal(store.errors.get('d'), 'The database went away.');
  });

  test('recorded, but the answer lost on the way back: the preview the row holds stays', async () => {
    const io = fakeIO(await picture(6000, 4000));
    const store = db({ posters: [row('l')], lost: true });
    const out = await runServerPreviews({ io, db: store, concurrency: 1 });
    assert.equal(out.failed, 1);
    assert.deepEqual(io.removed, []);
    assert.deepEqual([...io.stored.keys()], [store.log[0][2]]);
  });

  test('originals on disk at once stay within what /tmp takes: a claim asks only for the room the others leave', async () => {
    const io = fakeIO(await picture(3000, 2000));
    const MB = 1024 * 1024;
    const store = db({ posters: [row('o1', { size: 300 * MB }), row('o2', { size: 300 * MB })] });
    const out = await runServerPreviews({ io, db: store, concurrency: 2 });
    assert.equal(out.posters, 2);
    const asked = store.claimed.map((a) => a.maxBytes / MB);
    assert.deepEqual(asked.slice(0, 2), [450, 150], 'the second worker, while the first holds 300 MB');
    assert.ok(asked.slice(2).every((room) => room === 450 || room === 150), JSON.stringify(asked));
    const again = db({ posters: [row('o3', { size: 300 * MB })] });
    await runServerPreviews({ io, db: again, concurrency: 1 });
    assert.equal(again.claimed[0].maxBytes, SERVER_PREVIEW_MAX_BYTES, 'and every byte counted is given back');
  });

  test('a large preview someone else recorded meanwhile stays, and ours goes', async () => {
    const io = fakeIO(await picture(6000, 4000));
    const store = db({ posters: [row('p')], theirs: new Set(['p']) });
    const out = await runServerPreviews({ io, db: store, concurrency: 1 });
    assert.equal(out.kept, 1);
    assert.equal(out.posters, 0);
    assert.equal(io.stored.size, 0, 'the one it put is removed');
    assert.deepEqual(io.removed, [store.log[0][2]]);
    assert.deepEqual(store.drawn, []);
  });

  test('a failure is recorded with its reason, and the run goes on to the next', async () => {
    const good = await picture(6000, 4000);
    const io = fakeIO(good);
    io.read = async (file, path) => { await writeFile(path, file.id === 'x' ? Buffer.from('broken') : good); };
    const store = db({ posters: [row('x'), row('y')] });
    const out = await runServerPreviews({ io, db: store, concurrency: 1 });
    assert.equal(out.failed, 1);
    assert.ok(store.errors.get('x'));
    assert.match(out.errors[0], /^x\.jpg: /);
    assert.equal(out.posters, 1);
    assert.deepEqual(store.log.map(([what, id]) => [what, id]), [['poster', 'y']]);
  });

  test('pictures without a thumbnail come first, and placeholders, a few kilobytes each, before large previews', async () => {
    const io = fakeIO(await picture(3000, 2000));
    const store = db({
      whole: [row('w1', { thumbnailKey: null }), row('w2', { thumbnailKey: null })],
      placeholders: [row('h1', { metadata: {} })],
      posters: [row('p1'), row('p2')],
    });
    const out = await runServerPreviews({ io, db: store, concurrency: 1 });
    assert.deepEqual(store.log.map(([what, id]) => `${what} ${id}`), ['thumbnail w1', 'thumbnail w2', 'placeholder h1', 'poster p1', 'poster p2']);
    assert.deepEqual({ drawn: out.drawn, placeholders: out.placeholders, posters: out.posters }, { drawn: 2, placeholders: 1, posters: 2 });
  });
});

describe('what runs killed at maxDuration leave behind', () => {
  test('their directories go once they are older than any run lives; the rest stay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'onyx-stale-test-'));
    try {
      const make = async (name, ageMs) => {
        await mkdir(join(dir, name));
        await writeFile(join(dir, name, 'original'), 'x');
        const at = new Date(Date.now() - ageMs);
        await utimes(join(dir, name), at, at);
      };
      await make('onyx-preview-old', 20 * 60_000);
      await make('onyx-placeholder-old', 20 * 60_000);
      await make('onyx-preview-now', 30_000);
      await make('someone-elses', 20 * 60_000);
      await clearStaleTmp(dir);
      assert.deepEqual((await readdir(dir)).sort(), ['onyx-preview-now', 'someone-elses']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
    const drawn = [];
    const store = {
      async claimServerPreviews() { return []; },
      async claimServerPlaceholders() { if (handed) return []; handed = true; return [{ id: 'q', thumbnailKey: '_thumbs/0b5d.webp', thumbSizes: [] }]; },
      async setFilePlaceholder(id, placeholder, { thumbnailKey }) { set.push({ id, thumbnailKey, ok: !!placeholderFacts(placeholder) }); return {}; },
      async setServerPreviewError() {},
      async setServerPreviewDrawn(id) { drawn.push(id); },
    };
    const out = await runServerPreviews({ io, db: store, concurrency: 1 });
    assert.equal(out.placeholders, 1);
    assert.deepEqual(set, [{ id: 'q', thumbnailKey: '_thumbs/0b5d.webp', ok: true }]);
    assert.deepEqual(drawn, ['q'], 'its tries handed back, so its large preview need not wait out the last one');
  });
});
