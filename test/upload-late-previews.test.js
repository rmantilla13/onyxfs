// An upload is recorded as soon as its bytes land, with whatever previews
// are ready within PREVIEW_WAIT_MS; the rest are attached to the row when
// they are done (lib/upload-client.js). Its place in the queue is free from
// the moment the row is written, whatever the previews are still doing, and
// a thumbnail on its way is not drawn a second time by the backfill.
//
// The previews are handed over by the test (test/fixtures/upload-previews.mjs
// stands in for the drawing, which takes a canvas); the route is a stand-in
// fetch() and the bucket a stand-in XMLHttpRequest. Recording, attaching and
// the backfill are the real code.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const STUB = new URL('./fixtures/upload-previews.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    if (context.parentURL?.endsWith('/lib/upload-client.js') && /\/lib\/(thumbnail|filmstrip)-client\.js$/.test(r.url)) {
      return { url: STUB, shortCircuit: true };
    }
    return r;
  },
});

const { uploadOne, readyWithin, attachLater, PREVIEW_WAIT_MS, createUploadQueue } = await import('../lib/upload-client.js');
const { createThumbnailBackfill, thumbnailFromUpload } = await import(STUB);

const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
// By the clock nothing here mocks: some tests mock setTimeout.
const until = async (cond, what, ms = 5000) => {
  const end = performance.now() + ms;
  while (!cond()) {
    if (performance.now() > end) throw new Error(`never: ${what}`);
    await new Promise((r) => setImmediate(r));
  }
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

const THUMB = {
  key: '_thumbs/00000000-0000-4000-8000-000000000001.webp', posterKey: '_thumbs/00000000-0000-4000-8000-000000000001.poster.webp',
  thumbSizes: ['sm', 'xs'], media: { width: 640, height: 360, duration: 12.5 },
};
const STRIP = { key: '_thumbs/00000000-0000-4000-8000-000000000002.strip.webp', filmstrip: { frames: 40, columns: 8, tileWidth: 160, tileHeight: 90 } };

// ── the server ──
let server;
async function fakeFetch(url, init = {}) {
  const u = String(url);
  const method = init.method || 'GET';
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  if (u === '/api/files/config') return reply(200, { mode: 's3' });
  if (u === '/api/files/presign') {
    const b = JSON.parse(init.body);
    return reply(200, { putUrl: `https://bucket.test/put/${b.filename}`, publicUrl: `https://bucket.test/${b.filename}`, key: `files/${b.filename}`, name: b.filename });
  }
  if (u === '/api/files' && method === 'POST') {
    const b = JSON.parse(init.body);
    const id = `f${++server.made}`;
    server.records.push({ id, body: b });
    return reply(200, { file: { id, name: b.name, storage: 's3', mime: b.mime, url: b.url, thumbnailKey: b.thumbnailKey || null } });
  }
  const m = /^\/api\/files\/([^/]+)\/(thumbnail|filmstrip)$/.exec(u);
  if (m && method === 'PUT') {
    const b = JSON.parse(init.body);
    server.attached.push({ id: m[1], what: m[2], body: b });
    if (server.refuse.has(m[2])) return reply(403, { error: 'No access' });
    return reply(200, { file: { id: m[1], [`${m[2]}Url`]: `https://bucket.test/signed/${m[2]}`, seq: 2 } });
  }
  if (m && method === 'GET') { // the backfill asking whether it may
    server.asked.push(m[1]);
    return reply(403, {});
  }
  throw new Error(`unexpected ${method} ${u}`);
}
class BucketXHR {
  constructor() { this.upload = {}; }
  open(method, url) { this.url = url; }
  setRequestHeader() {}
  getResponseHeader() { return '"e"'; }
  abort() {}
  send(body) {
    setImmediate(() => {
      this.status = 200;
      this.upload.onprogress?.({ lengthComputable: true, loaded: body.size, total: body.size });
      server.landed += 1;
      this.onload?.();
    });
  }
}

const saved = {
  fetch: globalThis.fetch, XHR: globalThis.XMLHttpRequest,
  localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
};
beforeEach(() => {
  server = { made: 0, records: [], attached: [], asked: [], landed: 0, refuse: new Set() };
  globalThis.fetch = fakeFetch;
  globalThis.XMLHttpRequest = BucketXHR;
  // The backfill remembers a skip in localStorage; Node's own warns when read.
  const store = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, writable: true,
    value: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
  });
});
afterEach(() => {
  globalThis.fetch = saved.fetch;
  globalThis.XMLHttpRequest = saved.XHR;
  if (saved.localStorage) Object.defineProperty(globalThis, 'localStorage', saved.localStorage);
  else delete globalThis.localStorage;
});

const video = (name = 'clip.mp4') => new File([new Uint8Array(64)], name, { type: 'video/mp4', lastModified: 1 });

describe('readyWithin and attachLater', () => {
  test('readyWithin: the value if it comes in time, else null — the work going on regardless', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    assert.equal(await readyWithin(Promise.resolve('now'), 1000), 'now');
    assert.equal(await readyWithin(Promise.reject(new Error('x')), 1000), null, 'never rejects');
    const inTime = deferred();
    const waited = readyWithin(inTime.promise, 1000);
    t.mock.timers.tick(999);
    inTime.resolve('at 999 ms');
    await flush(3);
    t.mock.timers.tick(1);
    assert.equal(await waited, 'at 999 ms');
    const slow = deferred();
    const gaveUp = readyWithin(slow.promise, 1000);
    t.mock.timers.tick(1000);
    assert.equal(await gaveUp, null);
    slow.resolve('later');
    assert.equal(await slow.promise, 'later', 'still there for whoever attaches it');
  });

  test('attachLater: attaches what comes, nothing for nothing, and never rejects', async () => {
    const got = [];
    assert.equal(await attachLater(Promise.resolve('p'), async (v) => { got.push(v); return `row:${v}`; }), 'row:p');
    assert.equal(await attachLater(Promise.resolve(null), async () => { got.push('no'); }), null);
    assert.equal(await attachLater(Promise.reject(new Error('drawing failed')), async () => { got.push('no'); }), null);
    assert.equal(await attachLater(Promise.resolve('q'), async () => { throw new Error('403'); }), null);
    assert.deepEqual(got, ['p']);
  });
});

describe('an upload is recorded without waiting on its previews', () => {
  test('previews ready in time are recorded with the file, as before', async () => {
    globalThis.__up = { thumb: async () => THUMB, strip: async () => STRIP };
    const previews = [];
    const row = await uploadOne(video(), { folder: 'Cuts', onPreview: (f) => previews.push(f) });
    const { body } = server.records[0];
    assert.equal(row.id, 'f1');
    assert.equal(body.thumbnailKey, THUMB.key);
    assert.equal(body.posterKey, THUMB.posterKey);
    assert.deepEqual(body.thumbSizes, THUMB.thumbSizes);
    assert.deepEqual(body.media, THUMB.media);
    assert.equal(body.filmstripKey, STRIP.key);
    assert.deepEqual(body.filmstrip, STRIP.filmstrip);
    await flush();
    assert.deepEqual(server.attached, [], 'nothing left to attach');
    assert.deepEqual(previews, []);
  });

  test('at most PREVIEW_WAIT_MS after the bytes land; what was not ready is attached when it is', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const thumb = deferred();
    const strip = deferred();
    globalThis.__up = { thumb: () => thumb.promise, strip: () => strip.promise };
    const previews = [];
    const upload = uploadOne(video(), { folder: 'Cuts', onPreview: (f) => previews.push(f) });
    await until(() => server.landed === 1, 'the bytes land');
    await flush();
    assert.equal(server.records.length, 0, 'a moment for the previews');
    t.mock.timers.tick(PREVIEW_WAIT_MS - 1);
    await flush();
    assert.equal(server.records.length, 0);
    t.mock.timers.tick(1);
    const row = await upload;
    const { body } = server.records[0];
    assert.equal(body.thumbnailKey, undefined, 'recorded without them');
    assert.equal(body.filmstripKey, undefined);
    assert.equal(body.media, undefined);

    thumb.resolve(THUMB);
    await until(() => previews.length === 1, 'the thumbnail attached');
    assert.deepEqual(server.attached[0], {
      id: row.id, what: 'thumbnail',
      body: { thumbnailKey: THUMB.key, posterKey: THUMB.posterKey, thumbSizes: THUMB.thumbSizes, media: THUMB.media },
    });
    assert.equal(previews[0].thumbnailUrl, 'https://bucket.test/signed/thumbnail', 'the signed row, for the tile');
    strip.resolve(STRIP);
    await until(() => previews.length === 2, 'the filmstrip attached');
    assert.deepEqual(server.attached[1], { id: row.id, what: 'filmstrip', body: { filmstripKey: STRIP.key, filmstrip: STRIP.filmstrip } });
  });

  test('a preview that comes to nothing, or that the server refuses, is let go quietly', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const thumb = deferred();
    const strip = deferred();
    globalThis.__up = { thumb: () => thumb.promise, strip: () => strip.promise };
    server.refuse.add('filmstrip');
    const previews = [];
    const upload = uploadOne(video(), { onPreview: (f) => previews.push(f) });
    await until(() => server.landed === 1, 'the bytes land');
    await flush();
    t.mock.timers.tick(PREVIEW_WAIT_MS);
    await upload;
    thumb.resolve(null); // not a picture this browser draws
    strip.resolve(STRIP);
    await until(() => server.attached.length === 1, 'the filmstrip tried');
    await flush();
    assert.equal(server.attached[0].what, 'filmstrip');
    assert.deepEqual(previews, [], 'nothing to hand the page');
  });

  test('while a preview is on its way, leaving the page asks first', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const listeners = new Set();
    globalThis.window = {
      addEventListener: (type, fn) => { if (type === 'beforeunload') listeners.add(fn); },
      removeEventListener: (type, fn) => { if (type === 'beforeunload') listeners.delete(fn); },
    };
    try {
      const thumb = deferred();
      const strip = deferred();
      globalThis.__up = { thumb: () => thumb.promise, strip: () => strip.promise };
      const upload = uploadOne(video(), {});
      await until(() => server.landed === 1, 'the bytes land');
      await flush();
      assert.equal(listeners.size, 0, 'nothing to lose yet: the queue itself asks while it runs');
      t.mock.timers.tick(PREVIEW_WAIT_MS);
      await upload;
      assert.equal(listeners.size, 1, 'the file is recorded and its previews are still coming');
      const leaving = { returnValue: undefined, preventDefault() { this.prevented = true; } };
      [...listeners][0](leaving);
      assert.equal(leaving.prevented, true);
      thumb.resolve(THUMB);
      await until(() => server.attached.length === 1, 'the thumbnail attached');
      await flush();
      assert.equal(listeners.size, 1, 'the filmstrip still to come');
      strip.resolve(null);
      await until(() => listeners.size === 0, 'nothing left to lose');
    } finally {
      delete globalThis.window;
    }
  });

  test('the queue moves on when a file is recorded, not when its previews are done', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = [];
    globalThis.__up = {
      thumb: () => { const d = deferred(); pending.push(d); return d.promise; },
      strip: () => { const d = deferred(); pending.push(d); return d.promise; },
    };
    let snap = null;
    const q = createUploadQueue({ concurrency: 1, schedule: (fn) => fn(), onChange: (s) => { snap = s; }, run: (item, opts) => uploadOne(item.file, opts) });
    q.add([{ file: video('a.mp4') }, { file: video('b.mp4') }]);
    for (let n = 1; n <= 2; n++) {
      await until(() => server.landed === n, `file ${n}'s bytes land`);
      await flush();
      t.mock.timers.tick(PREVIEW_WAIT_MS);
      await until(() => server.records.length === n, `file ${n} recorded`);
    }
    await until(() => snap?.counts.done === 2, 'both done');
    assert.deepEqual(server.records.map((r) => r.body.name), ['a.mp4', 'b.mp4']);
    assert.equal(pending.length, 4, 'every preview still being drawn');
    for (const d of pending) d.resolve(null);
    await flush();
  });
});

describe('the backfill and an upload’s own thumbnail', () => {
  const tile = (id) => ({ id, storage: 's3', name: 'x.png', mime: 'image/png', kind: 'image', url: `https://bucket.test/${id}.png` });

  test('a tile shown before its thumbnail lands waits for the upload’s, and draws none of its own', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const thumb = deferred();
    globalThis.__up = { thumb: () => thumb.promise, strip: async () => null };
    const upload = uploadOne(video(), {});
    await until(() => server.landed === 1, 'the bytes land');
    await flush();
    t.mock.timers.tick(PREVIEW_WAIT_MS);
    const row = await upload;
    const ready = [];
    const request = createThumbnailBackfill((f) => ready.push(f));
    request(tile(row.id)); // the grid refreshed; the tile has no picture yet
    await flush();
    assert.deepEqual(server.asked, [], 'no original fetched, nothing asked');
    thumb.resolve(THUMB);
    await until(() => ready.length === 1, 'the upload’s thumbnail handed to the tile');
    assert.equal(ready[0].id, row.id);
    assert.equal(ready[0].thumbnailUrl, 'https://bucket.test/signed/thumbnail');
    assert.deepEqual(server.asked, []);
  });

  test('a tile asking again at every refresh still waits for the one thumbnail', async () => {
    const ready = [];
    const request = createThumbnailBackfill((f) => ready.push(f));
    const thumb = deferred();
    thumbnailFromUpload('f-busy', thumb.promise);
    for (let i = 0; i < 3; i++) {
      request(tile('f-busy')); // a new row object each refresh, the same file
      await flush(3);
    }
    assert.deepEqual(server.asked, [], 'no second thumbnail begun');
    thumb.resolve({ id: 'f-busy', thumbnailUrl: 'https://bucket.test/signed/thumbnail' });
    await until(() => ready.length === 1, 'handed over');
    await flush();
    assert.equal(ready.length, 1, 'once');
    assert.deepEqual(server.asked, []);
  });

  test('once it has landed: handed to a listing fetched before, for a minute — not to a tile that failed to show it', async (t) => {
    const ready = [];
    const request = createThumbnailBackfill((f) => ready.push(f));
    const landed = { id: 'f-landed', thumbnailUrl: 'https://bucket.test/signed/thumbnail' };
    await thumbnailFromUpload('f-landed', Promise.resolve(landed));
    request(tile('f-landed')); // a refresh that began before it landed
    await until(() => ready.length === 1, 'handed over');
    request(tile('f-landed')); // and another
    await until(() => ready.length === 2, 'handed over again');
    assert.deepEqual(server.asked, []);
    // A tile that has it, and could not show it, is the backfill's as ever.
    request({ ...tile('f-landed'), thumbnailUrl: landed.thumbnailUrl });
    await until(() => server.asked.includes('f-landed'), 'the backfill asks');
    assert.equal(ready.length, 2);

    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    await thumbnailFromUpload('f-old', Promise.resolve({ id: 'f-old', thumbnailUrl: 'https://bucket.test/signed/old' }));
    t.mock.timers.tick(61_000);
    request(tile('f-old'));
    await until(() => server.asked.includes('f-old'), 'a minute on: the backfill asks');
    assert.equal(ready.length, 2);
  });

  test('if the upload’s thumbnail does not land, the backfill goes on as it would have', async () => {
    const request = createThumbnailBackfill(() => {});
    thumbnailFromUpload('f-lost', Promise.resolve(null));
    request(tile('f-lost'));
    await until(() => server.asked.includes('f-lost'), 'the backfill asks whether it may draw one');
  });
});
