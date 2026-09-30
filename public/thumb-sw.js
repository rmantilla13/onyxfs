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
// cache and unregisters itself. Take app/components/PreviewWorker.js out of
// the root layout in the same deploy, or each page load installs the kill
// switch again only for it to remove itself again. Do not delete this file
// instead: a 404 leaves the installed worker running. middleware.js keeps
// this path outside the sign-in gate, so a signed-out browser can fetch the
// replacement too.

const CACHE = 'previews-v1';
const PREFIX = 'previews-';
const MAX_ENTRIES = 4000;
const TRIM_TO = 3600;
// A preview key (lib/media.js isThumbKey, isThumbSiblingKey, isPosterKey,
// isFilmstripKey) as the whole path, or after one segment: the bucket, in a
// path-style URL.
const PREVIEW_PATH = /^(?:\/[^/]+)?\/_thumbs\/[0-9a-f-]{36}(?:(?:\.(?:sm|xs|poster))?\.(?:webp|jpg)|\.strip\.webp)$/;

/** What a request is kept under — the URL's origin and path — or null when it is not a preview's. */
function previewCacheKey(request) {
  if (request.method !== 'GET' || request.mode === 'navigate') return null;
  let u;
  try { u = new URL(request.url); } catch { return null; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin === self.location.origin) return null;
  return PREVIEW_PATH.test(u.pathname) ? u.origin + u.pathname : null;
}

/** A picture that came back whole, over CORS. An opaque answer is never kept: Chrome pads each to megabytes of quota. */
function keepsResponse(res) {
  return !!res && res.ok === true && res.type === 'cors' && !res.redirected
    && /^image\//i.test(res.headers?.get?.('content-type') || '');
}

/** Once more than `max` are kept, the oldest keys — enough to leave `to`, so a full cache is not trimmed on every put. */
function trimPlan(keys, max, to) {
  return keys.length > max ? keys.slice(0, keys.length - Math.min(to, max)) : [];
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
      await Promise.all(names.filter((n) => n.startsWith(PREFIX) && n !== CACHE).map((n) => caches.delete(n)));
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
  let cache = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(key, { ignoreVary: true });
    if (hit) return hit;
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
    try { event.waitUntil(cache.put(key, res.clone()).then(added, () => {})); } catch { /* not kept this time */ }
  }
  return res;
}

// How many previews the cache holds, as this worker last counted them: null
// until it has counted once since it started. Counting reads every key, so
// it is done when the count says the cache may be over, not on every put.
let entries = null;
let trimming = null;

function added() {
  if (entries !== null && ++entries <= MAX_ENTRIES) return undefined;
  if (!trimming) trimming = trim().catch(() => {}).then(() => { trimming = null; });
  return trimming;
}

async function trim() {
  const cache = await caches.open(CACHE);
  const keys = await cache.keys();
  const doomed = trimPlan(keys, MAX_ENTRIES, TRIM_TO);
  await Promise.all(doomed.map((k) => cache.delete(k)));
  entries = keys.length - doomed.length;
}
