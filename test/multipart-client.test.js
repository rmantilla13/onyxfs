// The browser half of a multipart upload (lib/multipart-client.js): how part
// URLs are signed (a batch ahead, not a call per part), how many parts are
// in flight (a few, across every upload on the page, with no pause at any
// boundary), what an expired or refused URL does, and that a resume cuts the
// file as it was cut at create. The route is a stand-in fetch() and the
// bucket a stand-in XMLHttpRequest that the tests answer; the real ones are
// test/multipart-moto.test.js's.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { uploadFileMultipart, partSizeHint, slots, PARTS_AT_ONCE } = await import('../lib/multipart-client.js');

const MiB = 1024 * 1024;
const tick = () => new Promise((r) => setImmediate(r));
const until = async (cond, what) => {
  for (let i = 0; i < 2000; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`never: ${what}`);
};

// ── the route ──
let route;
function newRoute({ partSize = 10, status = null } = {}) {
  route = { partSize, status, calls: [], signs: [], nextSig: 0 };
}
async function fakeFetch(url, init = {}) {
  assert.equal(url, '/api/files/upload/multipart');
  const body = JSON.parse(init.body);
  route.calls.push(body);
  const ok = (json) => ({ ok: true, status: 200, json: async () => json });
  switch (body.action) {
    case 'create':
      return ok({ id: `up-${body.filename}`, key: `files/${body.filename}`, name: body.filename, partSize: route.partSize });
    case 'sign': {
      const sig = ++route.nextSig;
      route.signs.push({ id: body.id, parts: [...body.partNumbers], sig });
      return ok({ parts: body.partNumbers.map((n) => ({ partNumber: n, url: `https://bucket.test/${body.id}?partNumber=${n}&sig=${sig}` })) });
    }
    case 'status': return ok(route.status);
    case 'complete': return ok({ key: `files/${body.id}`, publicUrl: `https://bucket.test/${body.id}`, name: body.id });
    case 'abort': return ok({ ok: true });
    default: throw new Error(`unexpected action ${body.action}`);
  }
}

// ── the bucket ──
// Each PUT waits for the test — `answer(xhr, status)` — unless `auto` gives
// a status for it when it is sent, which is then answered a moment later.
const denied = '<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>';
class FakeXHR {
  static sent = [];
  static open = new Set();
  static most = 0;
  static auto = null; // (xhr) => status, or null to hold it
  constructor() { this.upload = {}; this.headers = {}; }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(k, v) { this.headers[k] = v; }
  getResponseHeader(k) { return String(k).toLowerCase() === 'etag' ? '"e"' : null; }
  get part() { return Number(new URL(this.url).searchParams.get('partNumber')); }
  get upload_() { return new URL(this.url).pathname.slice(1); }
  get sig() { return Number(new URL(this.url).searchParams.get('sig')); }
  send(body) {
    this.body = body;
    FakeXHR.sent.push(this);
    FakeXHR.open.add(this);
    FakeXHR.most = Math.max(FakeXHR.most, FakeXHR.open.size);
    const status = FakeXHR.auto ? FakeXHR.auto(this) : null;
    if (status != null) setImmediate(() => answer(this, status));
  }
  abort() {
    if (!FakeXHR.open.delete(this)) return;
    this.onabort?.();
  }
}
function answer(xhr, status = 200) {
  if (!FakeXHR.open.delete(xhr)) return;
  xhr.status = status;
  xhr.responseText = status === 403 ? denied : '';
  if (status === 200) xhr.upload.onprogress?.({ lengthComputable: true, loaded: xhr.body.size, total: xhr.body.size });
  xhr.onload?.();
}

const saved = { fetch: globalThis.fetch, XHR: globalThis.XMLHttpRequest };
beforeEach(() => {
  globalThis.fetch = fakeFetch;
  globalThis.XMLHttpRequest = FakeXHR;
  FakeXHR.sent = [];
  FakeXHR.open = new Set();
  FakeXHR.most = 0;
  FakeXHR.auto = () => 200;
  newRoute();
});
afterEach(() => {
  globalThis.fetch = saved.fetch;
  globalThis.XMLHttpRequest = saved.XHR;
});

const blob = (bytes, name = 'clip.mov') => Object.assign(new Blob([new Uint8Array(bytes)]), { name });
const partsPut = () => FakeXHR.sent.map((x) => x.part);

describe('partSizeHint', () => {
  test('64 MiB parts for a big file, about sixteen for a smaller one, never under 8 MiB', () => {
    assert.equal(partSizeHint(33 * MiB), 8 * MiB);
    assert.equal(partSizeHint(200 * MiB), 13 * MiB);
    assert.equal(partSizeHint(512 * MiB), 32 * MiB);
    assert.equal(partSizeHint(1024 * MiB), 64 * MiB);
    assert.equal(partSizeHint(20 * 1024 * MiB), 64 * MiB);
    for (const bad of [0, null, undefined, 'x', -5]) assert.equal(partSizeHint(bad), 8 * MiB);
  });

  test('create asks for it; the parts are cut at what the server settled on', async () => {
    newRoute({ partSize: 30 });
    await uploadFileMultipart(blob(100));
    const create = route.calls.find((c) => c.action === 'create');
    assert.equal(create.partSize, 8 * MiB, 'the hint for a 100-byte file');
    assert.deepEqual(FakeXHR.sent.map((x) => x.body.size).sort((a, b) => a - b), [10, 30, 30, 30]);
  });
});

describe('signing', () => {
  test('a batch ahead in one call, each part once — not a call per part', async () => {
    const out = await uploadFileMultipart(blob(400)); // 40 parts of 10 bytes
    assert.equal(out.key, 'files/up-clip.mov');
    const signed = route.signs.flatMap((s) => s.parts);
    assert.deepEqual([...signed].sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i + 1), 'each part signed once');
    assert.ok(route.signs.length <= 5, `${route.signs.length} sign calls for 40 parts`);
    assert.ok(route.signs.every((s) => s.parts.length <= PARTS_AT_ONCE * 2));
    assert.deepEqual(route.calls.at(-1), { action: 'complete', id: 'up-clip.mov' });
  });

  test('a first 403 is an expired URL: that part alone is signed again and sent', async () => {
    let refused = 0;
    FakeXHR.auto = (x) => (x.part === 3 && refused++ === 0 ? 403 : 200);
    await uploadFileMultipart(blob(200));
    const three = FakeXHR.sent.filter((x) => x.part === 3);
    assert.equal(three.length, 2);
    assert.notEqual(three[0].sig, three[1].sig, 'a new signature');
    assert.ok(route.signs.some((s) => s.parts.length === 1 && s.parts[0] === 3));
  });

  test('a dropped connection is tried again after a pause, on the URL it had — no new signature', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let dropped = 0;
    FakeXHR.auto = (x) => (x.part === 2 && dropped++ === 0 ? 0 : 200);
    const run = uploadFileMultipart(blob(60));
    await until(() => dropped === 1 && FakeXHR.sent.filter((x) => x.part === 2).length === 1 && !FakeXHR.open.size, 'the others done, part 2 waiting');
    await tick();
    t.mock.timers.tick(1000); // the first back-off
    await run;
    const two = FakeXHR.sent.filter((x) => x.part === 2);
    assert.equal(two.length, 2);
    assert.equal(two[0].sig, two[1].sig, 'the same signed URL');
    assert.deepEqual(route.signs.map((s) => s.parts), [[1, 2, 3, 4, 5, 6]], 'signed once');
  });

  test('a second 403 is a refusal: the upload fails saying so, and starts nothing more', async () => {
    FakeXHR.auto = (x) => (x.part === 2 ? 403 : 200);
    const e = await uploadFileMultipart(blob(300)).catch((err) => err);
    assert.match(e.message, /not allowed to write.*AccessDenied/);
    assert.equal(e.uploadId, 'up-clip.mov', 'kept for a retry');
    assert.equal(FakeXHR.sent.filter((x) => x.part === 2).length, 2);
    assert.ok(FakeXHR.sent.length < 30, `${FakeXHR.sent.length} PUTs of 30 parts`);
    assert.equal(route.calls.some((c) => c.action === 'complete'), false);
  });

  test('URLs that waited past their freshness are signed again, together', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    FakeXHR.auto = null;
    const run = uploadFileMultipart(blob(200)); // 20 parts
    await until(() => FakeXHR.open.size === PARTS_AT_ONCE, 'the first parts in flight');
    assert.deepEqual(route.signs.map((s) => s.parts), [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]);
    t.mock.timers.tick(41 * 60 * 1000); // a slow link: forty-one minutes for these five
    FakeXHR.auto = () => 200;
    for (const x of [...FakeXHR.open]) answer(x);
    await run;
    assert.deepEqual(route.signs[1].parts, [6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 'the stale five and the next five, in one call');
    assert.ok(FakeXHR.sent.filter((x) => x.part >= 6).every((x) => x.sig >= 2), 'no part sent on a stale URL');
  });
});

describe('parts in flight', () => {
  test('never more than PARTS_AT_ONCE, across two uploads at once, and all of them used', async () => {
    await Promise.all([uploadFileMultipart(blob(150, 'a.mov')), uploadFileMultipart(blob(150, 'b.mov'))]);
    assert.equal(FakeXHR.most, PARTS_AT_ONCE);
    assert.equal(FakeXHR.sent.length, 30);
    assert.deepEqual(new Set(FakeXHR.sent.map((x) => x.upload_)), new Set(['up-a.mov', 'up-b.mov']));
  });

  test('no pause at any boundary: a slow part holds one slot, not the upload', async () => {
    // 60 parts: more than the fifty the old loop took at a time, and waited
    // out, whole, before the next fifty.
    FakeXHR.auto = (x) => (x.part === 1 ? null : 200);
    const run = uploadFileMultipart(blob(600));
    await until(() => FakeXHR.sent.length === 60, 'every part sent');
    const first = FakeXHR.sent.find((x) => x.part === 1);
    assert.ok(FakeXHR.open.has(first), 'part 1 still in flight while the other 59 went');
    answer(first, 200);
    await run;
    assert.deepEqual([...new Set(partsPut())].sort((a, b) => a - b), Array.from({ length: 60 }, (_, i) => i + 1));
  });

  test('a paused upload waiting for a slot lets go of it, and the other goes on', async () => {
    FakeXHR.auto = null;
    const a = uploadFileMultipart(blob(100, 'a.mov'));
    await until(() => FakeXHR.open.size === PARTS_AT_ONCE, 'a fills the slots');
    const stop = new AbortController();
    const b = uploadFileMultipart(blob(100, 'b.mov'), { signal: stop.signal }).catch((e) => e);
    await until(() => route.calls.some((c) => c.action === 'create' && c.filename === 'b.mov'), 'b started');
    await tick();
    stop.abort();
    const paused = await b;
    assert.equal(paused.name, 'AbortError');
    assert.equal(paused.uploadId, 'up-b.mov');
    FakeXHR.auto = () => 200;
    for (const x of [...FakeXHR.open]) answer(x);
    await a;
    assert.equal(FakeXHR.sent.some((x) => x.upload_ === 'up-b.mov'), false, 'b sent nothing');
    // Every slot came back: a third upload runs five at once again.
    FakeXHR.most = 0;
    await uploadFileMultipart(blob(100, 'c.mov'));
    assert.equal(FakeXHR.most, PARTS_AT_ONCE);
  });
});

describe('resume', () => {
  test('uses the part size the upload was created with, and sends only what is missing', async () => {
    newRoute({
      status: { upload: { partSize: 16, size: 100 }, parts: [{ partNumber: 1, size: 16 }, { partNumber: 2, size: 16 }], uploaded: 32 },
    });
    const progress = [];
    await uploadFileMultipart(blob(100), { resumeId: 'up-old', onProgress: (p) => progress.push(p.uploaded) });
    assert.equal(route.calls.some((c) => c.action === 'create'), false);
    assert.deepEqual(FakeXHR.sent.map((x) => [x.part, x.body.size]).sort((a, b) => a[0] - b[0]), [[3, 16], [4, 16], [5, 16], [6, 16], [7, 4]]);
    assert.equal(progress[0], 32, 'starts from what landed');
    assert.equal(progress.at(-1), 100);
  });
});

describe('slots', () => {
  test('first come, first served; a waiter that aborts gives nothing back', async () => {
    const s = slots(2);
    const order = [];
    await s.take();
    await s.take();
    const stop = new AbortController();
    const a = s.take().then(() => order.push('a'));
    const b = s.take(stop.signal).then(() => order.push('b'), (e) => order.push(e.name));
    const c = s.take().then(() => order.push('c'));
    stop.abort();
    s.give();
    s.give();
    await Promise.all([a, b, c]);
    assert.deepEqual(order, ['AbortError', 'a', 'c']);
    s.give();
    s.give();
    assert.equal(await s.run(async () => 'ran'), 'ran');
  });
});
