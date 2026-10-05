// The preview worker (public/thumb-sw.js) keeps thumbnails and the other
// previews by key, so a picture seen once is read from disk whatever its
// signature says. It is a static file that cannot import its rules, so this
// runs the file itself — in a vm, against Cache Storage and fetch in memory —
// and checks that it agrees with lib/preview-cache.js, that it never costs a
// picture, that a trim takes what was not used rather than what was kept
// first, and that the kill switch its comment documents works as written.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  PREVIEW_WORKER_URL, PREVIEW_CACHE, PREVIEW_CACHE_PREFIX, PREVIEW_CACHE_MAX, PREVIEW_CACHE_TRIM_TO,
  PREVIEW_LARGE_CACHE, PREVIEW_LARGE_CACHE_MAX, PREVIEW_LARGE_CACHE_TRIM_TO,
  isPreviewKey, previewCacheKey, previewCacheName, keepsResponse, trimPlan, refreshes, clearPreviewCaches, registerPreviewWorker,
} from '../lib/preview-cache.js';
import { isThumbKey, isThumbSiblingKey, isPosterKey, isFilmstripKey } from '../lib/media.js';

const src = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const WORKER = await src(`public${PREVIEW_WORKER_URL}`);
const APP = 'https://app.example.com';
const B2 = 'https://s3.us-west-004.backblazeb2.com';
const UUID = '0b8f2c1e-1111-4222-8333-944455556666';
const uuidN = (n) => `${String(n).padStart(8, '0')}-1111-4222-8333-944455556666`;

const PREVIEWS = [
  `_thumbs/${UUID}.webp`, `_thumbs/${UUID}.jpg`,
  `_thumbs/${UUID}.sm.webp`, `_thumbs/${UUID}.sm.jpg`, `_thumbs/${UUID}.xs.webp`, `_thumbs/${UUID}.xs.jpg`,
  `_thumbs/${UUID}.poster.webp`, `_thumbs/${UUID}.poster.jpg`,
  `_thumbs/${UUID}.strip.webp`,
];
const NOT_PREVIEWS = [
  `_thumbs/${UUID}.proxy.mp4`, `_thumbs/${UUID}.strip.jpg`, `_thumbs/${UUID}.png`, `_thumbs/${UUID.toUpperCase()}.webp`,
  `_thumbs/${UUID}.md.webp`, `_thumbs/${UUID}.sm.poster.webp`, `_thumbs/${UUID}.WEBP`, `_thumbs/${UUID}.webp/`,
  '_thumbs/x.webp', `thumbs/${UUID}.webp`, 'files/a-thumb-b.jpg', `files/${UUID}.webp`,
];

/** Every URL shape a page could ask for, previews and not. */
function urlTable() {
  const bases = [
    `${B2}/onyx-files/`, // path-style: B2, and every custom endpoint
    'https://onyx-files.s3.us-east-2.amazonaws.com/', // virtual-hosted
    'http://127.0.0.1:59000/onyx/', // the local bucket
    'https://cdn.example.com/', // a CDN in front of the bucket
    `${APP}/`, `${APP}/b/`, // the app itself
    `${B2}/onyx-files/files/`, // a `_thumbs` folder among someone's files
    `${B2}/a/b/`,
  ];
  const tails = ['', '?X-Amz-Date=20260929T000000Z&X-Amz-Signature=abc', '#x', '?a=1#y'];
  const out = [];
  for (const base of bases) for (const key of [...PREVIEWS, ...NOT_PREVIEWS]) for (const tail of tails) out.push(base + key + tail);
  out.push('not a url', '', 'data:image/webp;base64,AAAA', `blob:${APP}/${UUID}`, `ftp://h/_thumbs/${UUID}.webp`, `https://h/_thumbs/${UUID}.webp`);
  return out;
}

/** A response as a cross-origin fetch with CORS hands it back. */
function corsResponse(body = 'pixels', { status = 200, type = 'image/webp', redirected = false } = {}) {
  const r = new Response(body, { status, headers: { 'content-type': type } });
  Object.defineProperty(r, 'type', { value: 'cors' });
  if (redirected) Object.defineProperty(r, 'redirected', { value: true });
  return r;
}
/** What an <img>'s request without CORS gets: nothing readable. */
function opaqueResponse() {
  const r = new Response(null, { status: 200 });
  Object.defineProperty(r, 'type', { value: 'opaque' });
  Object.defineProperty(r, 'status', { value: 0 });
  Object.defineProperty(r, 'ok', { value: false });
  return r;
}

/**
 * Cache Storage in memory: named caches of URL → response, in the order they
 * were put. A put replaces an entry by taking it to the back, as the spec
 * and Chrome do; `inPlace` replaces it where it is, as WebKit does. `putFails`
 * is a full disk.
 */
function memoryCaches({ broken = false, inPlace = false, putFails = false } = {}) {
  const stores = new Map();
  const calls = { keys: 0, put: 0, delete: 0 };
  const urlOf = (r) => (typeof r === 'string' ? r : r.url);
  const cache = (m) => ({
    async match(r) { const v = m.get(urlOf(r)); return v ? v.clone() : undefined; },
    async put(r, res) {
      calls.put++;
      if (putFails) throw new DOMException('Quota exceeded.', 'QuotaExceededError');
      if (!inPlace) m.delete(urlOf(r));
      m.set(urlOf(r), res);
    },
    async keys() { calls.keys++; return [...m.keys()].map((u) => new Request(u)); },
    async delete(r) { calls.delete++; return m.delete(urlOf(r)); },
  });
  return {
    stores,
    calls,
    async open(name) {
      if (broken) throw new DOMException('The operation is insecure.', 'SecurityError');
      if (!stores.has(name)) stores.set(name, new Map());
      return cache(stores.get(name));
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
}

/** fetch, answered by `reply` and remembered. */
function recordingFetch(reply) {
  const calls = [];
  const f = async (input, init = {}) => {
    const call = typeof input === 'string' ? { url: input, ...init } : { request: input };
    calls.push(call);
    return reply(call);
  };
  f.calls = calls;
  return f;
}

/** The worker's script in a context of its own, with `caches` and `fetch` as given. */
function loadWorker({ code = WORKER, caches = memoryCaches(), fetch = recordingFetch(() => corsResponse()), URLPattern } = {}) {
  const listeners = {};
  const log = { skipWaiting: 0, claim: 0, unregister: 0 };
  const scope = {
    URL, Request, Response, Headers, DOMException, console, setTimeout, clearTimeout,
    caches,
    fetch,
    location: new URL(`${APP}${PREVIEW_WORKER_URL}`),
    clients: { claim: async () => { log.claim++; } },
    registration: { unregister: async () => { log.unregister++; return true; } },
    skipWaiting: async () => { log.skipWaiting++; },
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  if (URLPattern) scope.URLPattern = URLPattern;
  scope.self = scope;
  vm.createContext(scope);
  vm.runInContext(code, scope, { filename: 'thumb-sw.js' });
  return { listeners, log, caches, fetch, get: (name) => vm.runInContext(name, scope) };
}

/** A fetch event for `url` through the worker; resolves once it has answered and finished writing. */
async function dispatch(w, url, { method = 'GET', mode = 'no-cors' } = {}) {
  const waits = [];
  const event = {
    request: { url, method, mode, credentials: 'include' },
    responded: null,
    respondWith(p) { this.responded = Promise.resolve(p); },
    waitUntil(p) { waits.push(Promise.resolve(p)); },
  };
  w.listeners.fetch(event);
  const response = event.responded ? await event.responded : null;
  await Promise.all(waits);
  return { event, response, answered: !!event.responded };
}

const kept = (w, name = PREVIEW_CACHE) => [...(w.caches.stores.get(name)?.keys() || [])];
/** The worker's line for a cache as it last read it: each key's place. */
const line = (w, name = PREVIEW_CACHE) => w.get('queues')[name].places;

/** A cache already holding `n` previews, the first kept first; `key(i)` is the i-th's name under `_thumbs/`. */
function fill(caches, cacheName, n, key) {
  const store = new Map();
  caches.stores.set(cacheName, store);
  for (let i = 0; i < n; i++) store.set(`${B2}/onyx-files/_thumbs/${key(i)}`, corsResponse());
  return store;
}

describe('what is kept, and under what (lib/preview-cache.js)', () => {
  test('a preview key is one the server names — a thumbnail, a sibling, a poster, a filmstrip — and nothing else', () => {
    for (const key of PREVIEWS) {
      assert.equal(isPreviewKey(key), true, key);
      assert.equal([isThumbKey, isThumbSiblingKey, isPosterKey, isFilmstripKey].filter((is) => is(key)).length, 1, key);
    }
    for (const key of NOT_PREVIEWS) assert.equal(isPreviewKey(key), false, key);
  });

  test('kept under the origin and path, whatever the signature says', () => {
    const at = (url, init = {}) => previewCacheKey({ url, method: 'GET', mode: 'no-cors', ...init }, APP);
    const today = `${B2}/onyx-files/_thumbs/${UUID}.sm.webp?X-Amz-Date=20260929T000000Z&X-Amz-Signature=aaa`;
    const tomorrow = `${B2}/onyx-files/_thumbs/${UUID}.sm.webp?X-Amz-Date=20260930T000000Z&X-Amz-Signature=bbb`;
    assert.equal(at(today), `${B2}/onyx-files/_thumbs/${UUID}.sm.webp`, 'path-style: the bucket is in the path');
    assert.equal(at(tomorrow), at(today), 'a new signature is the same picture');
    assert.equal(at(`https://onyx-files.s3.us-east-2.amazonaws.com/_thumbs/${UUID}.webp?X-Amz-Signature=c`),
      `https://onyx-files.s3.us-east-2.amazonaws.com/_thumbs/${UUID}.webp`, 'virtual-hosted');
    assert.equal(at(`${B2}/other-bucket/_thumbs/${UUID}.sm.webp`), `${B2}/other-bucket/_thumbs/${UUID}.sm.webp`, 'another bucket is another key');
    assert.equal(at(today, { mode: 'cors' }), at(today), 'a page’s own fetch of it too');
  });

  test('never the app’s own routes, an original, a proxy, someone’s `_thumbs` folder, or anything but a GET', () => {
    const at = (url, init = {}) => previewCacheKey({ url, method: 'GET', mode: 'no-cors', ...init }, APP);
    assert.equal(at(`${APP}/_thumbs/${UUID}.webp`), null, 'same origin');
    assert.equal(at(`${B2}/onyx-files/files/Shoot/A001.jpg?X-Amz-Signature=a`), null);
    assert.equal(at(`${B2}/onyx-files/_thumbs/${UUID}.proxy.mp4`), null, 'a proxy is streamed in ranges, not kept');
    assert.equal(at(`${B2}/onyx-files/files/_thumbs/${UUID}.webp`), null, 'a user folder named _thumbs can change');
    assert.equal(at(`${B2}/onyx-files/_thumbs/${UUID}.webp`, { method: 'HEAD' }), null);
    assert.equal(at(`${B2}/onyx-files/_thumbs/${UUID}.webp`, { method: 'POST' }), null);
    assert.equal(at(`${B2}/onyx-files/_thumbs/${UUID}.webp`, { mode: 'navigate' }), null);
    assert.equal(at('not a url'), null);
    assert.equal(at(`blob:${APP}/${UUID}`), null);
  });

  test('only a whole picture that came back over CORS is kept', () => {
    assert.equal(keepsResponse(corsResponse()), true);
    assert.equal(keepsResponse(corsResponse('x', { type: 'image/jpeg' })), true);
    assert.equal(keepsResponse(opaqueResponse()), false, 'opaque: padded to megabytes of quota in Chrome');
    assert.equal(keepsResponse(corsResponse('x', { status: 403 })), false, 'an expired signature');
    assert.equal(keepsResponse(corsResponse('<html>', { type: 'text/html' })), false);
    assert.equal(keepsResponse(corsResponse('x', { redirected: true })), false);
    assert.equal(keepsResponse(new Response('x', { headers: { 'content-type': 'image/webp' } })), false, 'not CORS');
    assert.equal(keepsResponse(null), false);
  });

  test('a trim waits for the cap, then drops the oldest down to where it will not be needed for a while', () => {
    const keys = Array.from({ length: PREVIEW_CACHE_MAX + 1 }, (_, i) => `k${i}`);
    assert.deepEqual(trimPlan(keys.slice(0, PREVIEW_CACHE_MAX)), [], 'at the cap, nothing');
    const doomed = trimPlan(keys);
    assert.equal(keys.length - doomed.length, PREVIEW_CACHE_TRIM_TO);
    assert.deepEqual(doomed, keys.slice(0, doomed.length), 'the oldest first');
    assert.ok(PREVIEW_CACHE_TRIM_TO < PREVIEW_CACHE_MAX);
    assert.deepEqual(trimPlan(['a', 'b', 'c'], 2, 5), ['a'], 'never leaves more than the cap');
    assert.deepEqual(trimPlan(null), []);
  });

  test('posters and filmstrips are kept apart from the thumbnails, fewer of them', () => {
    const name = (key) => previewCacheName(`${B2}/onyx-files/${key}`);
    for (const key of PREVIEWS) {
      assert.equal(name(key), isPosterKey(key) || isFilmstripKey(key) ? PREVIEW_LARGE_CACHE : PREVIEW_CACHE, key);
    }
    assert.equal(previewCacheName(`https://onyx-files.s3.us-east-2.amazonaws.com/_thumbs/${UUID}.poster.jpg`), PREVIEW_LARGE_CACHE, 'virtual-hosted');
    assert.equal(previewCacheName(`https://onyx-files.s3.us-east-2.amazonaws.com/_thumbs/${UUID}.xs.jpg`), PREVIEW_CACHE);
    for (const key of NOT_PREVIEWS) assert.equal(name(key), null, key);
    assert.equal(previewCacheName('not a url'), null);
    assert.equal(previewCacheName(undefined), null);
    assert.notEqual(PREVIEW_LARGE_CACHE, PREVIEW_CACHE);
    assert.ok(PREVIEW_LARGE_CACHE_MAX < PREVIEW_CACHE_MAX, 'a few hundred kilobytes each: fewer of them');
    assert.ok(PREVIEW_LARGE_CACHE_TRIM_TO < PREVIEW_LARGE_CACHE_MAX);
  });

  test('a picture seen again is put again only when among the oldest quarter of a full cache', () => {
    const max = PREVIEW_CACHE_MAX;
    // A full cache: the one at the front has max - 1 put after it.
    assert.equal(refreshes(max - 1, max), true, 'the front of the line');
    assert.equal(refreshes((max * 3) / 4, max), true, 'the last of the oldest quarter');
    assert.equal(refreshes((max * 3) / 4 - 1, max), false, 'the first of the rest');
    assert.equal(refreshes(0, max), false, 'the back of the line');
    assert.equal(refreshes(max * 2, max), true, 'a cache past its cap, before its trim');
    // Never on every hit: a small cache has nothing near a trim.
    assert.equal(refreshes(0, 1), false);
    for (let n = 1; n < (max * 3) / 4; n++) if (refreshes(n - 1, max)) assert.fail(`${n} kept, the oldest put again`);
    assert.equal(refreshes(PREVIEW_LARGE_CACHE_MAX - 1, PREVIEW_LARGE_CACHE_MAX), true);
    assert.equal(refreshes((PREVIEW_LARGE_CACHE_MAX * 3) / 4 - 1, PREVIEW_LARGE_CACHE_MAX), false);
    // Whatever is put again has been through the whole window before the
    // trim would take it.
    assert.ok((max * 3) / 4 < PREVIEW_CACHE_TRIM_TO && (PREVIEW_LARGE_CACHE_MAX * 3) / 4 < PREVIEW_LARGE_CACHE_TRIM_TO);
    for (const [since, m] of [[undefined, max], [null, max], [NaN, max], ['3999', max], [1.5, 4], [3999, 0], [3999, -4], [3999, null]]) {
      assert.equal(refreshes(since, m), false, `${since} of ${m}`);
    }
    assert.equal(refreshes(3999), true, 'the thumbnails’ cap by default');
  });
});

describe('the worker agrees with lib/preview-cache.js', () => {
  test('the same names and limits', () => {
    const w = loadWorker();
    assert.equal(w.get('CACHE'), PREVIEW_CACHE);
    assert.equal(w.get('LARGE_CACHE'), PREVIEW_LARGE_CACHE);
    assert.equal(w.get('PREFIX'), PREVIEW_CACHE_PREFIX);
    assert.equal(w.get('MAX_ENTRIES'), PREVIEW_CACHE_MAX);
    assert.equal(w.get('TRIM_TO'), PREVIEW_CACHE_TRIM_TO);
    assert.equal(w.get('LARGE_MAX_ENTRIES'), PREVIEW_LARGE_CACHE_MAX);
    assert.equal(w.get('LARGE_TRIM_TO'), PREVIEW_LARGE_CACHE_TRIM_TO);
    for (const name of [PREVIEW_CACHE, PREVIEW_LARGE_CACHE]) {
      assert.ok(name.startsWith(PREVIEW_CACHE_PREFIX), `clearing by prefix reaches ${name}`);
    }
  });

  test('the same caches', () => {
    const w = loadWorker();
    const workerName = w.get('previewCacheName');
    let large = 0;
    for (const url of urlTable()) {
      const key = previewCacheKey({ url }, APP);
      assert.equal(workerName(key), previewCacheName(key), url);
      if (key) assert.ok(previewCacheName(key), url);
      if (previewCacheName(key) === PREVIEW_LARGE_CACHE) large++;
      // Anything else handed to it, the same refusal.
      assert.equal(workerName(url), previewCacheName(url), url);
    }
    // The four bases a bucket keeps them at, three of the previews (two
    // posters and a filmstrip), each tail.
    assert.equal(large, 4 * 3 * 4);
    for (const v of [undefined, null, '', 42]) assert.equal(workerName(v), previewCacheName(v), String(v));
  });

  test('the same pictures put again', () => {
    const w = loadWorker();
    const workerRefreshes = w.get('refreshes');
    // The worker always passes its cap; only the module has a default.
    for (const max of [PREVIEW_CACHE_MAX, PREVIEW_LARGE_CACHE_MAX, 1, 3, 4, 5, 0, -4, null, 4.5]) {
      for (const since of [0, 1, 2, 3, 4, 299, 300, 2999, 3000, 3001, 3999, 4000, 9000, -1, 1.5, undefined, null, NaN, '3000']) {
        assert.equal(workerRefreshes(since, max), refreshes(since, max), `${since} of ${max}`);
      }
    }
  });

  test('the same requests, under the same keys', () => {
    const w = loadWorker();
    const workerKey = w.get('previewCacheKey');
    let previews = 0;
    for (const url of urlTable()) {
      for (const method of ['GET', 'HEAD', 'POST']) {
        for (const mode of ['no-cors', 'cors', 'same-origin', 'navigate']) {
          const want = previewCacheKey({ url, method, mode }, APP);
          assert.equal(workerKey({ url, method, mode }), want, `${method} ${mode} ${url}`);
          if (want) previews++;
        }
      }
    }
    // The four bases on another origin with the key where a bucket keeps it,
    // each preview with each tail, plus https://h/_thumbs/…; as a GET that is
    // not a navigation (no-cors, cors, same-origin).
    assert.equal(previews, (4 * PREVIEWS.length * 4 + 1) * 3);
  });

  test('the same answers kept', () => {
    const w = loadWorker();
    const workerKeeps = w.get('keepsResponse');
    const cases = [
      corsResponse(), corsResponse('x', { type: 'IMAGE/JPEG' }), corsResponse('x', { status: 404 }), corsResponse('x', { type: 'text/html' }),
      corsResponse('x', { type: '' }), corsResponse('x', { redirected: true }), opaqueResponse(), new Response('x'),
      null, undefined, {}, { ok: true, type: 'cors', redirected: false, headers: null },
    ];
    for (const res of cases) assert.equal(workerKeeps(res), keepsResponse(res), String(res?.type));
  });

  test('the same trims', () => {
    const w = loadWorker();
    // Into this realm's arrays: the worker's `[]` is the vm context's own.
    const workerTrim = (...args) => Array.from(w.get('trimPlan')(...args));
    for (const n of [0, 1, 2, 3, 4, 5, PREVIEW_CACHE_TRIM_TO, PREVIEW_CACHE_MAX, PREVIEW_CACHE_MAX + 1, PREVIEW_CACHE_MAX + 250]) {
      const keys = Array.from({ length: n }, (_, i) => i);
      assert.deepEqual(workerTrim(keys, PREVIEW_CACHE_MAX, PREVIEW_CACHE_TRIM_TO), trimPlan(keys), `${n}`);
      assert.deepEqual(workerTrim(keys, 3, 2), trimPlan(keys, 3, 2), `${n} of 3`);
      assert.deepEqual(workerTrim(keys, 3, 9), trimPlan(keys, 3, 9), `${n} of 3, to 9`);
    }
  });

  // URLPattern is a global only in a newer Node than the .nvmrc's 22, which
  // skips this one.
  const noPattern = typeof globalThis.URLPattern !== 'function' && 'no URLPattern in this Node';
  test('Chrome’s route sends everything but previews to the network, and never a preview', { skip: noPattern }, () => {
    let routes = null;
    const w = loadWorker({ URLPattern: globalThis.URLPattern });
    w.listeners.install({ addRoutes: (r) => { routes = r; return Promise.resolve(); } });
    assert.equal(w.log.skipWaiting, 1);
    assert.equal(routes.source, 'network');
    const pattern = routes.condition.not.urlPattern;
    assert.equal(pattern.hasRegExpGroups, false, 'Chrome refuses a route with regexp groups');
    const workerKey = w.get('previewCacheKey');
    for (const url of urlTable()) {
      if (workerKey({ url, method: 'GET', mode: 'no-cors' })) assert.equal(pattern.test(url), true, `reaches the worker: ${url}`);
    }
    for (const url of [`${APP}/files?folder=Shoot`, `${APP}/_next/static/chunks/app.js`, `${APP}/api/files?limit=100`, `${B2}/onyx-files/files/A001.mov?X-Amz-Signature=a`]) {
      assert.equal(pattern.test(url), false, `straight to the network: ${url}`);
    }
  });
});

describe('the worker never costs a picture', () => {
  test('a miss asks again with CORS and no credentials, answers, and keeps it by key; tomorrow’s signature is a hit', async () => {
    const fetch = recordingFetch(() => corsResponse('pixels'));
    const w = loadWorker({ fetch });
    const today = `${B2}/onyx-files/_thumbs/${UUID}.sm.webp?X-Amz-Date=20260929T000000Z&X-Amz-Signature=aaa`;
    const first = await dispatch(w, today);
    assert.equal(await first.response.text(), 'pixels');
    assert.deepEqual(fetch.calls, [{ url: today, mode: 'cors', credentials: 'omit' }]);
    assert.deepEqual(kept(w), [`${B2}/onyx-files/_thumbs/${UUID}.sm.webp`], 'no signature in the key');

    const tomorrow = today.replace('20260929', '20260930').replace('aaa', 'bbb');
    const second = await dispatch(w, tomorrow);
    assert.equal(await second.response.text(), 'pixels');
    assert.equal(fetch.calls.length, 1, 'read from the cache, not downloaded again');
  });

  test('everything else is left alone: not answered at all', async () => {
    const fetch = recordingFetch(() => corsResponse());
    const w = loadWorker({ fetch });
    for (const [url, init] of [
      [`${APP}/files`, { mode: 'navigate' }],
      [`${APP}/_next/static/chunks/app.js`, {}],
      [`${APP}/api/files?limit=100`, { mode: 'cors' }],
      [`${B2}/onyx-files/files/A001.jpg?X-Amz-Signature=a`, {}],
      [`${B2}/onyx-files/_thumbs/${UUID}.proxy.mp4?X-Amz-Signature=a`, {}],
      [`${B2}/onyx-files/_thumbs/${UUID}.webp`, { method: 'HEAD' }],
    ]) {
      const { answered } = await dispatch(w, url, init);
      assert.equal(answered, false, url);
    }
    assert.equal(fetch.calls.length, 0);
  });

  test('a bucket without CORS: the page’s own request goes out, and nothing is kept', async () => {
    const opaque = opaqueResponse();
    const fetch = recordingFetch((call) => {
      if (call.mode === 'cors') throw new TypeError('Failed to fetch');
      return opaque;
    });
    const w = loadWorker({ fetch });
    const { event, response } = await dispatch(w, `${B2}/onyx-files/_thumbs/${UUID}.webp?X-Amz-Signature=a`);
    assert.equal(response, opaque);
    assert.equal(fetch.calls.length, 2);
    assert.equal(fetch.calls[1].request, event.request, 'exactly as the page made it');
    assert.deepEqual(kept(w), []);
  });

  test('an error, a page that is not a picture, a redirect: answered as they came, not kept', async () => {
    for (const res of [corsResponse('denied', { status: 403 }), corsResponse('<html>', { type: 'text/html' }), corsResponse('x', { redirected: true })]) {
      const w = loadWorker({ fetch: recordingFetch(() => res) });
      const { response } = await dispatch(w, `${B2}/onyx-files/_thumbs/${UUID}.webp?X-Amz-Signature=a`);
      assert.equal(response, res);
      assert.deepEqual(kept(w), []);
    }
  });

  test('no Cache Storage (a private window, storage blocked): still answered, over CORS', async () => {
    const fetch = recordingFetch(() => corsResponse('pixels'));
    const w = loadWorker({ caches: memoryCaches({ broken: true }), fetch });
    const { response } = await dispatch(w, `${B2}/onyx-files/_thumbs/${UUID}.webp?X-Amz-Signature=a`);
    assert.equal(await response.text(), 'pixels');
    assert.equal(fetch.calls.length, 1);
  });

  test('anything thrown on the way: the page’s own request goes out', async () => {
    const plain = corsResponse('plain');
    const fetch = recordingFetch((call) => (call.request ? plain : { ok: true, type: 'cors', redirected: false, headers: { get() { throw new Error('boom'); } } }));
    const w = loadWorker({ fetch });
    const { event, response } = await dispatch(w, `${B2}/onyx-files/_thumbs/${UUID}.webp?X-Amz-Signature=a`);
    assert.equal(response, plain);
    assert.equal(fetch.calls.at(-1).request, event.request);
  });

  test('offline: the request fails as it would have without the worker', async () => {
    const w = loadWorker({ fetch: recordingFetch(() => { throw new TypeError('Failed to fetch'); }) });
    await assert.rejects(dispatch(w, `${B2}/onyx-files/_thumbs/${UUID}.webp?X-Amz-Signature=a`), TypeError);
  });

  test('at the cap the oldest go, and the keys are read again only when the count says so', async () => {
    const caches = memoryCaches();
    const store = new Map();
    caches.stores.set(PREVIEW_CACHE, store);
    for (let i = 0; i < PREVIEW_CACHE_MAX; i++) store.set(`${B2}/onyx-files/_thumbs/${uuidN(i)}.webp`, corsResponse());
    const w = loadWorker({ caches, fetch: recordingFetch(() => corsResponse()) });

    await dispatch(w, `${B2}/onyx-files/_thumbs/${UUID}.webp?X-Amz-Signature=a`);
    assert.equal(store.size, PREVIEW_CACHE_TRIM_TO);
    assert.equal(store.has(`${B2}/onyx-files/_thumbs/${uuidN(0)}.webp`), false, 'the oldest went first');
    assert.equal(store.has(`${B2}/onyx-files/_thumbs/${UUID}.webp`), true, 'the newest stayed');
    assert.equal(line(w).size, PREVIEW_CACHE_TRIM_TO);
    assert.equal(caches.calls.keys, 1);

    await dispatch(w, `${B2}/onyx-files/_thumbs/${UUID}.sm.webp?X-Amz-Signature=a`);
    assert.equal(caches.calls.keys, 1, 'under the cap, a put is counted, not listed');
    assert.equal(line(w).size, PREVIEW_CACHE_TRIM_TO + 1);
  });

  test('a picture seen again near the front goes to the back, so the trim takes what was not used', async () => {
    const caches = memoryCaches();
    const store = fill(caches, PREVIEW_CACHE, PREVIEW_CACHE_MAX, (i) => `${uuidN(i)}.sm.webp`);
    const w = loadWorker({ caches, fetch: recordingFetch(() => corsResponse()) });
    const at = (i) => `${B2}/onyx-files/_thumbs/${uuidN(i)}.sm.webp`;

    // A folder used every day: some of the first pictures ever kept.
    for (const i of [5, 10, 11]) {
      const { response } = await dispatch(w, `${at(i)}?X-Amz-Signature=today`);
      assert.equal(await response.text(), 'pixels', 'answered from the cache');
    }
    assert.equal(caches.calls.keys, 1, 'the line is read once, at the first hit');
    assert.deepEqual([...store.keys()].slice(-3), [at(5), at(10), at(11)], 'each now at the back');
    assert.equal(caches.calls.put, 3);
    assert.equal(store.size, PREVIEW_CACHE_MAX, 'moved, not copied');

    // Seen again from the back, or from anywhere short of the oldest
    // quarter: nothing is written.
    const quarter = PREVIEW_CACHE_MAX / 4;
    for (const i of [5, 10, 11, PREVIEW_CACHE_MAX - 1, quarter + 20, quarter + 3]) await dispatch(w, at(i));
    assert.equal(caches.calls.put, 3, 'a hit away from the front is a read and nothing more');
    // From just inside it, it is.
    await dispatch(w, at(quarter - 3));
    assert.equal(caches.calls.put, 4);
    assert.equal([...store.keys()].at(-1), at(quarter - 3));

    // A new picture takes the cache past its cap: the trim takes the front,
    // which is no longer the first pictures kept but the first not used.
    await dispatch(w, `${B2}/onyx-files/_thumbs/${UUID}.sm.webp?X-Amz-Signature=a`);
    assert.equal(store.size, PREVIEW_CACHE_TRIM_TO);
    for (const i of [5, 10, 11, quarter - 3]) assert.equal(store.has(at(i)), true, `${i}, used, stayed`);
    for (const i of [0, 4, 6, 12]) assert.equal(store.has(at(i)), false, `${i}, never seen again, went`);
    assert.equal(caches.calls.keys, 2, 'listed again only for the trim');
  });

  test('the same picture seen twice at once is put again once', async () => {
    const caches = memoryCaches();
    fill(caches, PREVIEW_CACHE, PREVIEW_CACHE_MAX, (i) => `${uuidN(i)}.webp`);
    const w = loadWorker({ caches, fetch: recordingFetch(() => corsResponse()) });
    const url = `${B2}/onyx-files/_thumbs/${uuidN(0)}.webp?X-Amz-Signature=a`;
    const both = await Promise.all([dispatch(w, url), dispatch(w, url)]);
    for (const { response } of both) assert.equal(await response.text(), 'pixels');
    assert.equal(caches.calls.put, 1);
  });

  test('where a replaced entry keeps its place, as in WebKit, a picture put again still goes to the back', async () => {
    const caches = memoryCaches({ inPlace: true });
    const store = fill(caches, PREVIEW_CACHE, PREVIEW_CACHE_MAX, (i) => `${uuidN(i)}.webp`);
    const w = loadWorker({ caches, fetch: recordingFetch(() => corsResponse()) });
    await dispatch(w, `${B2}/onyx-files/_thumbs/${uuidN(0)}.webp`);
    assert.equal([...store.keys()].at(-1), `${B2}/onyx-files/_thumbs/${uuidN(0)}.webp`);
    assert.equal(store.size, PREVIEW_CACHE_MAX);
  });

  test('a full disk while putting a picture back: the page has its picture all the same', async () => {
    const caches = memoryCaches({ putFails: true });
    fill(caches, PREVIEW_CACHE, PREVIEW_CACHE_MAX, (i) => `${uuidN(i)}.webp`);
    const fetch = recordingFetch(() => corsResponse());
    const w = loadWorker({ caches, fetch });
    const { response } = await dispatch(w, `${B2}/onyx-files/_thumbs/${uuidN(0)}.webp`);
    assert.equal(await response.text(), 'pixels');
    assert.equal(caches.calls.put, 1);
    assert.equal(fetch.calls.length, 0);
    // Gone from the cache, it is fetched and kept again the next time it is seen.
    const again = await dispatch(w, `${B2}/onyx-files/_thumbs/${uuidN(0)}.webp`);
    assert.equal(await again.response.text(), 'pixels');
    assert.equal(fetch.calls.length, 1);
  });

  test('posters and filmstrips are kept in a cache of their own, trimmed to its own cap', async () => {
    const caches = memoryCaches();
    const thumbs = fill(caches, PREVIEW_CACHE, 10, (i) => `${uuidN(i)}.webp`);
    const large = fill(caches, PREVIEW_LARGE_CACHE, PREVIEW_LARGE_CACHE_MAX, (i) => `${uuidN(i)}.${i % 2 ? 'poster.webp' : 'strip.webp'}`);
    const fetch = recordingFetch(() => corsResponse('large'));
    const w = loadWorker({ caches, fetch });

    await dispatch(w, `${B2}/onyx-files/_thumbs/${UUID}.poster.jpg?X-Amz-Signature=a`);
    assert.equal(large.size, PREVIEW_LARGE_CACHE_TRIM_TO, 'past its cap of a few hundred, trimmed');
    assert.equal(large.has(`${B2}/onyx-files/_thumbs/${UUID}.poster.jpg`), true);
    assert.equal(large.has(`${B2}/onyx-files/_thumbs/${uuidN(0)}.strip.webp`), false, 'the front went');
    assert.equal(thumbs.size, 10, 'the thumbnails untouched');

    await dispatch(w, `${B2}/onyx-files/_thumbs/${UUID}.strip.webp?X-Amz-Signature=a`);
    await dispatch(w, `${B2}/onyx-files/_thumbs/${UUID}.xs.webp?X-Amz-Signature=a`);
    assert.equal(large.has(`${B2}/onyx-files/_thumbs/${UUID}.strip.webp`), true);
    assert.deepEqual(kept(w).slice(-1), [`${B2}/onyx-files/_thumbs/${UUID}.xs.webp`]);
    assert.equal(large.size, PREVIEW_LARGE_CACHE_TRIM_TO + 1);
    assert.equal(thumbs.size, 11);

    // Seen again, each from its own cache.
    const before = fetch.calls.length;
    await dispatch(w, `${B2}/onyx-files/_thumbs/${UUID}.poster.jpg?X-Amz-Signature=b`);
    await dispatch(w, `${B2}/onyx-files/_thumbs/${uuidN(3)}.webp?X-Amz-Signature=b`);
    assert.equal(fetch.calls.length, before);
  });

  test('a poster kept among the thumbnails before the two were apart goes when that cache is read', async () => {
    const caches = memoryCaches();
    const thumbs = fill(caches, PREVIEW_CACHE, 6, (i) => `${uuidN(i)}.${i % 3 ? 'webp' : 'poster.webp'}`);
    const w = loadWorker({ caches, fetch: recordingFetch(() => corsResponse()) });
    await dispatch(w, `${B2}/onyx-files/_thumbs/${uuidN(1)}.webp`);
    assert.deepEqual(kept(w), [1, 2, 4, 5].map((i) => `${B2}/onyx-files/_thumbs/${uuidN(i)}.webp`));
    assert.equal(line(w).size, 4);
  });

  test('a new version drops the old one’s caches, keeps both of its own and anyone else’s, and takes over open pages', async () => {
    const caches = memoryCaches();
    for (const name of ['previews-v0', PREVIEW_CACHE, PREVIEW_LARGE_CACHE, 'previews-large-v0', 'someone-else']) caches.stores.set(name, new Map());
    const w = loadWorker({ caches });
    const waits = [];
    w.listeners.activate({ waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    assert.deepEqual([...caches.stores.keys()], [PREVIEW_CACHE, PREVIEW_LARGE_CACHE, 'someone-else']);
    assert.equal(w.log.claim, 1);
  });

  test('installing never fails over the routes, where there are none or they are refused', () => {
    const bare = loadWorker();
    bare.listeners.install({});
    assert.equal(bare.log.skipWaiting, 1);
    const refused = loadWorker({ URLPattern: globalThis.URLPattern || class {} });
    refused.listeners.install({ addRoutes: () => { throw new TypeError('not supported'); } });
    refused.listeners.install({ addRoutes: () => Promise.reject(new TypeError('not supported')) });
    assert.equal(refused.log.skipWaiting, 2);
  });
});

test('the kill switch in the worker’s comment works as written', async () => {
  const lines = WORKER.split('\n').filter((l) => l.startsWith('//   ')).map((l) => l.slice(5));
  assert.ok(lines.length >= 3, 'the kill switch is in the comment');
  const caches = memoryCaches();
  for (const name of [PREVIEW_CACHE, PREVIEW_LARGE_CACHE, 'previews-v0', 'someone-else']) caches.stores.set(name, new Map([['k', corsResponse()]]));
  const w = loadWorker({ code: lines.join('\n'), caches });
  assert.equal(w.listeners.fetch, undefined, 'no fetch handler: every request goes to the network');
  w.listeners.install({});
  const waits = [];
  w.listeners.activate({ waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.deepEqual([...caches.stores.keys()], ['someone-else'], 'every version of both caches dropped');
  assert.equal(w.log.unregister, 1);
  assert.equal(w.log.skipWaiting, 1, 'it takes over at once rather than waiting for tabs to close');
});

describe('the page’s side', () => {
  test('clearing deletes every version of both preview caches, and nothing else', async () => {
    const deleted = [];
    const names = [PREVIEW_CACHE, PREVIEW_LARGE_CACHE, 'previews-v0', 'previews-large-v0', 'someone-else'];
    const store = { keys: async () => names, delete: async (n) => { deleted.push(n); return true; } };
    await clearPreviewCaches({ store });
    assert.deepEqual(deleted.sort(), ['previews-large-v0', 'previews-large-v1', 'previews-v0', 'previews-v1']);
    assert.ok(deleted.includes(PREVIEW_CACHE) && deleted.includes(PREVIEW_LARGE_CACHE));
  });

  test('signing out clears what the worker kept, both caches', async () => {
    const caches = memoryCaches();
    const fetch = recordingFetch(() => corsResponse());
    const w = loadWorker({ caches, fetch });
    await dispatch(w, `${B2}/onyx-files/_thumbs/${UUID}.webp?X-Amz-Signature=a`);
    await dispatch(w, `${B2}/onyx-files/_thumbs/${UUID}.poster.webp?X-Amz-Signature=a`);
    caches.stores.set('someone-else', new Map());
    assert.deepEqual([...caches.stores.keys()], [PREVIEW_CACHE, PREVIEW_LARGE_CACHE, 'someone-else']);
    await clearPreviewCaches({ store: caches });
    assert.deepEqual([...caches.stores.keys()], ['someone-else']);
    // The worker's next answer comes from the network, and is kept again.
    await dispatch(w, `${B2}/onyx-files/_thumbs/${UUID}.webp?X-Amz-Signature=b`);
    assert.equal(fetch.calls.length, 3);
    assert.deepEqual(kept(w), [`${B2}/onyx-files/_thumbs/${UUID}.webp`]);
  });

  test('clearing never holds up signing out, and never throws', async () => {
    await clearPreviewCaches({ store: undefined });
    await clearPreviewCaches({ store: null });
    await clearPreviewCaches({ store: { keys: () => Promise.reject(new DOMException('no', 'SecurityError')) } });
    await clearPreviewCaches({ store: { keys: () => { throw new Error('sync'); } } });
    await clearPreviewCaches({ store: { get keys() { throw new DOMException('sandboxed', 'SecurityError'); } } });
    await clearPreviewCaches({ store: { keys: async () => 'not a list', delete: async () => true } });
    const t0 = Date.now();
    await clearPreviewCaches({ store: { keys: () => new Promise(() => {}) }, timeoutMs: 20 });
    assert.ok(Date.now() - t0 < 1000, 'a hung disk is given up on');
  });

  test('registering: nothing without service workers; after the page has loaded; an installed worker is asked to update', async () => {
    registerPreviewWorker({ nav: {}, win: {}, doc: {} });
    registerPreviewWorker({ nav: undefined, win: undefined, doc: undefined });

    const calls = [];
    let onLoad = null;
    const nav = (active) => ({
      serviceWorker: {
        register: async (url, opts) => { calls.push(['register', url, opts]); return { active, update: async () => { calls.push(['update']); } }; },
      },
    });
    const win = { addEventListener: (type, fn, opts) => { if (type === 'load' && opts?.once) onLoad = fn; } };
    registerPreviewWorker({ nav: nav({}), win, doc: { readyState: 'interactive' } });
    assert.deepEqual(calls, [], 'not while the page is still loading');
    onLoad();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, [['register', PREVIEW_WORKER_URL, { scope: '/' }], ['update']]);

    calls.length = 0;
    registerPreviewWorker({ nav: nav(null), win, doc: { readyState: 'complete' } });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, [['register', PREVIEW_WORKER_URL, { scope: '/' }]], 'installing for the first time: no update to ask for');

    const refusing = { serviceWorker: { register: () => Promise.reject(new DOMException('no', 'SecurityError')) } };
    registerPreviewWorker({ nav: refusing, win, doc: { readyState: 'complete' } });
    const throwing = { serviceWorker: { register: () => { throw new TypeError('no'); } } };
    registerPreviewWorker({ nav: throwing, win, doc: { readyState: 'complete' } });
    const sandboxed = { get serviceWorker() { throw new DOMException('sandboxed', 'SecurityError'); } };
    registerPreviewWorker({ nav: sandboxed, win, doc: { readyState: 'complete' } });
    await new Promise((r) => setImmediate(r));
  });

  test('installed from the root layout, on every page', async () => {
    const layout = await src('app/layout.js');
    assert.match(layout, /<PreviewWorker \/>/);
    const worker = await src('app/components/PreviewWorker.js');
    assert.match(worker, /^'use client';/);
    assert.match(worker, /useEffect\(\(\) => \{ registerPreviewWorker\(\); \}, \[\]\)/);
  });

  test('both ways to sign out clear the cache before leaving, and the sign-in page clears it', async () => {
    const menu = await src('app/components/ProfileMenu.js');
    assert.match(menu, /href="\/api\/auth\/signout"[^>]*onClick=\{signOut\}/);
    const handler = menu.slice(menu.indexOf('function signOut('));
    assert.ok(handler.indexOf('clearPreviewCaches()') < handler.indexOf('window.location.assign(href)'), 'cleared, then gone');
    const palette = await src('app/components/CommandPalette.js');
    assert.match(palette, /clearPreviewCaches\(\)\.then\(\(\) => \{ window\.location\.href = '\/api\/auth\/signout'; \}\)/);
    const signin = await src('app/signin/SignInClient.js');
    assert.match(signin, /useEffect\(\(\) => \{ clearPreviewCaches\(\); \}, \[\]\)/);
  });

  test('the worker’s script is outside the sign-in gate, and nothing else new is', async () => {
    const mw = await src('middleware.js');
    const pattern = /matcher:\s*\[\s*'([^']+)'/.exec(mw)[1].replace(/\\\\/g, '\\');
    const { pathToRegexp } = await import('next/dist/compiled/path-to-regexp/index.js');
    const gated = (p) => pathToRegexp(pattern).test(p);
    assert.equal(gated(PREVIEW_WORKER_URL), false, 'a signed-out browser can fetch the kill switch');
    for (const p of ['/thumb-sw.jsx', '/thumb-sw.js/x', '/x/thumb-sw.js', '/files', '/files/abc', '/api/files/abc']) {
      assert.equal(gated(p), true, p);
    }
  });
});
