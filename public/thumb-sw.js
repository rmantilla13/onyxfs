// thumb-sw.js — keeps preview pictures by their key, not their signed URL.
//
// A preview (a thumbnail, its sm and xs siblings, a player poster, a
// filmstrip) never changes under its key, but its signed URL changes once a
// day (lib/storage.js PREVIEW_URL_WINDOW), and the browser's HTTP cache is
// keyed by the whole URL. This worker keeps each preview under the bucket's
// origin and the key's path with the signature cut off, so a picture seen
// once is read from disk on every later visit, whatever its signature says.
// It answers nothing else: in Chrome nothing else even reaches it (the route
// set up at install), and elsewhere the fetch handler lets everything that
// is not a preview go by without a word.
//
// Its rules are copies of lib/preview-cache.js's — a file in /public cannot
// import a module the bundler builds — and test/preview-cache.test.js runs
// this file against them and fails when the two disagree.
//
// Posters and filmstrips, a few hundred kilobytes each, are kept apart from
// the grid thumbnails, tens of kilobytes each, with a cap of their own, so
// neither kind crowds out the other. Each cache is a line: a picture kept
// goes to the back, and a trim takes from the front. A picture seen again
// while near the front is put again, which takes it to the back, so what is
// used is what stays; seen anywhere else, nothing is written.
//
// It must never cost a picture. Whatever goes wrong in here — no Cache
// Storage, a full disk, a bucket with no CORS rule, anything thrown — the
// page still gets its picture from the network, and nothing is kept.
//
// The kill switch. An installed worker outlives the deploy that installed
// it: a browser keeps running it until it fetches a different file from
// this path, which every page load asks it to do (lib/preview-cache.js,
// registerPreviewWorker). To take this worker out of every browser, replace
// this file, at this same path, with
//
//   self.addEventListener('install', () => self.skipWaiting());
//   self.addEventListener('activate', (event) => event.waitUntil((async () => {
//     for (const name of await caches.keys()) if (name.startsWith('previews-')) await caches.delete(name);
//     await self.registration.unregister();
//   })()));
//
// It has no fetch handler, so from the moment it activates every request
// goes to the network as though there were no worker; then it drops the
// caches and unregisters itself. Take app/components/PreviewWorker.js out of
// the root layout in the same deploy, or each page load installs the kill
// switch again only for it to remove itself again. Do not delete this file
// instead: a 404 leaves the installed worker running. middleware.js keeps
// this path outside the sign-in gate, so a signed-out browser can fetch the
// replacement too.

const CACHE = 'previews-v1';
const LARGE_CACHE = 'previews-large-v1';
const PREFIX = 'previews-';
const MAX_ENTRIES = 4000;
const TRIM_TO = 3600;
const LARGE_MAX_ENTRIES = 400;
const LARGE_TRIM_TO = 360;
// A preview key (lib/media.js isThumbKey, isThumbSiblingKey, isPosterKey,
// isFilmstripKey) as the whole path, or after one segment: the bucket, in a
// path-style URL.
const PREVIEW_PATH = /^(?:\/[^/]+)?\/_thumbs\/[0-9a-f-]{36}(?:(?:\.(?:sm|xs|poster))?\.(?:webp|jpg)|\.strip\.webp)$/;
// Of those, a poster or a filmstrip: kept in LARGE_CACHE.
const LARGE_PATH = /\.(?:poster|strip)\.(?:webp|jpg)$/;

/** What a request is kept under — the URL's origin and path — or null when it is not a preview's. */
function previewCacheKey(request) {
  if (request.method !== 'GET' || request.mode === 'navigate') return null;
  let u;
  try { u = new URL(request.url); } catch { return null; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin === self.location.origin) return null;
  return PREVIEW_PATH.test(u.pathname) ? u.origin + u.pathname : null;
}

/** The cache a preview is kept in, by its key: a poster or a filmstrip in the large one. Null for a key that is not a preview's. */
function previewCacheName(key) {
  let path;
  try { path = new URL(key).pathname; } catch { return null; }
  if (!PREVIEW_PATH.test(path)) return null;
  return LARGE_PATH.test(path) ? LARGE_CACHE : CACHE;
}

/** A picture that came back whole, over CORS. An opaque answer is never kept: Chrome pads each to megabytes of quota. */
function keepsResponse(res) {
  return !!res && res.ok === true && res.type === 'cors' && !res.redirected
    && /^image\//i.test(res.headers?.get?.('content-type') || '');
}

/** Once more than `max` are kept, the keys at the front of the line — enough to leave `to`, so a full cache is not trimmed on every put. */
function trimPlan(keys, max, to) {
  return keys.length > max ? keys.slice(0, keys.length - Math.min(to, max)) : [];
}

/** Whether a picture seen again is put again: once three quarters of a full cache have been put after it, it is near the front. */
function refreshes(since, max) {
  return Number.isInteger(since) && Number.isInteger(max) && max > 0 && since * 4 >= max * 3;
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // Chrome: whatever is not under a `_thumbs/` path — a navigation, the
  // app's own scripts and API calls, an original — goes straight to the
  // network without starting this worker at all. Without it everything comes
  // to the fetch handler, which lets it by.
  try {
    if (typeof event.addRoutes === 'function' && typeof URLPattern === 'function') {
      Promise.resolve(event.addRoutes({
        condition: { not: { urlPattern: new URLPattern({ pathname: '*/_thumbs/*' }) } },
        source: 'network',
      })).catch(() => {});
    }
  } catch { /* the fetch handler sorts requests just the same */ }
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith(PREFIX) && n !== CACHE && n !== LARGE_CACHE).map((n) => caches.delete(n)));
    } catch { /* an older version's cache waits for the next activation */ }
    try { await self.clients.claim(); } catch { /* pages already open are taken over when they reload */ }
  })());
});

self.addEventListener('fetch', (event) => {
  let key = null;
  try { key = previewCacheKey(event.request); } catch { key = null; }
  if (!key) return;
  // Anything thrown on the way sends the request out as the page made it.
  event.respondWith(answer(event, key).catch(() => null).then((res) => res || fetch(event.request)));
});

/** The kept copy, or the picture fetched with CORS and kept; null to let the page's own request go. */
async function answer(event, key) {
  const queue = queues[previewCacheName(key)];
  let cache = null;
  try {
    cache = await caches.open(queue.name);
    const hit = await cache.match(key, { ignoreVary: true });
    if (hit) {
      // Moved to the back if it is near the front, after the page has its answer.
      try { event.waitUntil(seen(queue, key).catch(() => {})); } catch { /* left where it is this time */ }
      return hit;
    }
  } catch { cache = null; }
  // Not kept yet. An <img> asks without CORS, and an opaque answer cannot be
  // kept, so the same URL is asked for again with CORS and no credentials. A
  // bucket that refuses that (no CORS rule) is sent the page's own request
  // instead, and nothing is kept. So is a URL whose non-CORS copy the HTTP
  // cache still holds from before this worker, which fails the CORS check in
  // some browsers: served from there as ever, it is kept once its URL next
  // changes.
  let res;
  try { res = await fetch(event.request.url, { mode: 'cors', credentials: 'omit' }); } catch { return null; }
  if (cache && keepsResponse(res)) {
    // Written after the page has its answer; the worker stays up for it.
    try { event.waitUntil(cache.put(key, res.clone()).then(() => added(queue, key)).catch(() => {})); } catch { /* not kept this time */ }
  }
  return res;
}

// Each cache's line as this worker last read it: `places` has a place for
// every key, front to back in the order Cache Storage lists them, numbered
// from a count that only goes up, so `next - 1 - place` is how many were put
// after a key. It is null until the line has been read once since the worker
// started. Reading lists every key — about a fifth of a second for a full
// cache in Chrome, though hits are answered alongside it — so it is done
// then, and again only when the count says the cache may be over its cap,
// not on every put or hit.
const queues = {
  [CACHE]: { name: CACHE, max: MAX_ENTRIES, to: TRIM_TO, places: null, next: 0, trimming: null },
  [LARGE_CACHE]: { name: LARGE_CACHE, max: LARGE_MAX_ENTRIES, to: LARGE_TRIM_TO, places: null, next: 0, trimming: null },
};

/** To the back of the line: a key put again leaves its old place. */
function place(queue, key) {
  queue.places.delete(key);
  queue.places.set(key, queue.next++);
}

/** A picture was just put, so it is at the back. Past the cap, or before the line has been read, the cache is read and trimmed. */
async function added(queue, key) {
  // A read under way may have listed the cache before this put.
  if (queue.trimming) await queue.trimming;
  if (!queue.places) return trim(queue);
  place(queue, key);
  if (queue.places.size > queue.max) await trim(queue);
  return undefined;
}

/**
 * A kept picture was answered. Near the front of the line (refreshes) it is
 * put again, to the back, so the next trims take what has not been used
 * rather than what was kept first; anywhere else nothing is written. It is
 * deleted before it is put back: WebKit — Safari, Onyx for Mac's web view —
 * keeps a replaced entry where it was in the line.
 */
async function seen(queue, key) {
  if (queue.trimming || !queue.places) await trim(queue);
  const at = queue.places?.get(key);
  if (at === undefined || !refreshes(queue.next - 1 - at, queue.max)) return;
  // Placed before anything is awaited, so the same picture seen twice at once is put once.
  place(queue, key);
  const cache = await caches.open(queue.name);
  const copy = await cache.match(key, { ignoreVary: true });
  if (!copy) return;
  await cache.delete(key);
  await cache.put(key, copy);
}

/** Read the line and trim it to its cap, one read at a time: a call while one is under way waits for that one. Never rejects. */
function trim(queue) {
  if (!queue.trimming) queue.trimming = readAndTrim(queue).catch(() => {}).then(() => { queue.trimming = null; });
  return queue.trimming;
}

async function readAndTrim(queue) {
  const cache = await caches.open(queue.name);
  const keys = await cache.keys();
  // A picture kept in the other cache's place — a poster among the
  // thumbnails, from before the two were kept apart — is never looked for
  // here again, so it goes too.
  const line = [];
  const stray = [];
  for (const k of keys) (previewCacheName(k.url) === queue.name ? line : stray).push(k);
  const doomed = trimPlan(line, queue.max, queue.to);
  await Promise.all([...stray, ...doomed].map((k) => cache.delete(k)));
  const places = new Map();
  let next = 0;
  for (let i = doomed.length; i < line.length; i++) places.set(line[i].url, next++);
  queue.places = places;
  queue.next = next;
}
