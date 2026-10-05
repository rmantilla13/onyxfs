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
// goes to the back, and a trim takes from the front. Each picture carries a
// stamp, the count of new pictures its cache had kept when it was put, and
// each cache keeps that count in a tally of its own, so a hit tells how many
// new pictures have come in after it from the copy it is answered with. The
// cache is never listed for a hit: in WebKit a listing of a full cache holds
// up every read behind it for a quarter of a second or more, hits included,
// as the reads a grid sends do. Once half as many new pictures as a trim
// leaves have come in after it, a picture seen again is put again, which
// takes it to the back, so what is used is what stays. Any other hit writes
// nothing, and a picture put again is not put again until as many more new
// ones have come in: seeing the same pictures over and over writes nothing.
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
const LARGE_MAX_ENTRIES = 1000;
const LARGE_TRIM_TO = 900;
// The header a kept picture carries its stamp in. Its cache's tally carries
// the count so far in it too, and how many pictures the cache holds in HELD.
const STAMP = 'x-onyx-kept';
const HELD = 'x-onyx-held';
// What each cache's tally is kept under: on the site's own origin, so never a
// preview's key (previewCacheKey refuses the site's own).
const TALLY = `${self.location.origin}/_previews/tally`;
// A trim deletes this many at a time, so a hit asked for meanwhile waits for
// a few deletes rather than hundreds.
const DELETES_AT_ONCE = 50;
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

/** Whether a picture seen again is put again: once `since` new pictures, half as many as a trim leaves (`to`), have been kept after it. */
function refreshes(since, to) {
  return Number.isInteger(since) && Number.isInteger(to) && to > 0 && since * 2 >= to;
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
    // A picture on its way to the back is out of the cache for a moment.
    const moving = queue.moving.get(key);
    if (moving) await moving;
    const hit = await cache.match(key, { ignoreVary: true });
    if (hit) {
      // Put again if it is old enough, after the page has its answer.
      try { event.waitUntil(seen(queue, key, stampOf(hit)).catch(() => {})); } catch { /* left where it is this time */ }
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
    try { event.waitUntil(keep(queue, cache, key, res.clone()).catch(() => {})); } catch { /* not kept this time */ }
  }
  return res;
}

// Each cache's tally as this worker has it: `kept`, the count of new
// pictures put so far, and `held`, how many pictures the cache holds, or null
// until something has counted them. Both are read from the cache's tally
// once per worker lifetime, the first time either is needed, and written
// back after each new picture and each trim. The cache is listed only to
// trim it, or to count it once when no tally says how many it holds (a cache
// from before there were tallies), never for a hit.
const queues = {
  [CACHE]: newQueue(CACHE, MAX_ENTRIES, TRIM_TO),
  [LARGE_CACHE]: newQueue(LARGE_CACHE, LARGE_MAX_ENTRIES, LARGE_TRIM_TO),
};

function newQueue(name, max, to) {
  return {
    name, max, to, kept: 0, held: null,
    loading: null, unsaved: false, saving: null, trimming: null,
    // Pictures on their way to the back, by key, and, while a trim runs,
    // those that were on their way when it began to read the line or set off
    // after.
    moving: new Map(), moved: null,
  };
}

/** A whole number written in a header, or null. */
function whole(value) {
  return typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : null;
}

/**
 * A kept picture's stamp. One without (kept before pictures carried one) came
 * in before every picture that has, so it counts as kept before the first.
 */
function stampOf(res) {
  return whole(res.headers.get(STAMP)) ?? 0;
}

/** The same picture, carrying `stamp`. */
function stamped(res, stamp) {
  const headers = new Headers(res.headers);
  headers.set(STAMP, String(stamp));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Read the cache's tally, once per lifetime. Never rejects. */
function load(queue) {
  if (!queue.loading) {
    queue.loading = (async () => {
      try {
        const saved = await (await caches.open(queue.name)).match(TALLY);
        if (!saved) return;
        queue.kept = Math.max(queue.kept, whole(saved.headers.get(STAMP)) ?? 0);
        queue.held = whole(saved.headers.get(HELD));
      } catch { /* counted afresh: the next put lists the cache */ }
    })();
  }
  return queue.loading;
}

/** Write the tally as it is now. A write while one is under way is folded into the next. Never rejects. */
function save(queue) {
  queue.unsaved = true;
  if (!queue.saving) queue.saving = Promise.resolve().then(() => flush(queue));
  return queue.saving;
}

async function flush(queue) {
  try {
    const cache = await caches.open(queue.name);
    while (queue.unsaved) {
      queue.unsaved = false;
      const headers = { [STAMP]: String(queue.kept) };
      if (queue.held !== null) headers[HELD] = String(queue.held);
      await cache.put(TALLY, new Response(null, { headers }));
    }
  } catch { /* written with the next change */ }
  queue.saving = null;
}

/** A new picture was fetched: put it at the back with the next stamp, and trim the cache once it is past its cap. */
async function keep(queue, cache, key, res) {
  await load(queue);
  queue.kept += 1;
  await cache.put(key, stamped(res, queue.kept));
  // A trim under way may have listed the cache before this put.
  if (queue.trimming) await queue.trimming;
  // Nothing has counted this cache yet: listing it counts this one too.
  if (queue.held === null) return trim(queue);
  queue.held += 1;
  return queue.held > queue.max ? trim(queue) : save(queue);
}

/** Whether a kept picture with this stamp is put again when it is seen. */
function stale(queue, stamp) {
  return refreshes(queue.kept - stamp, queue.to);
}

/**
 * A kept picture was answered. Once enough new pictures have come in after
 * it (refreshes), it is put again, to the back, so the next trims take what
 * has not been used rather than what was kept first; otherwise nothing is
 * written.
 */
async function seen(queue, key, stamp) {
  await load(queue);
  // A tally behind its pictures (one not written before the worker stopped) catches up.
  if (stamp > queue.kept) queue.kept = stamp;
  if (!stale(queue, stamp) || queue.moving.has(key)) return undefined;
  // Marked before anything is awaited, so the same picture seen twice at once is put once.
  const move = toBack(queue, key).catch(() => {}).then(() => { queue.moving.delete(key); });
  queue.moving.set(key, move);
  return move;
}

/**
 * Put a kept picture again with the latest stamp. It is deleted first:
 * WebKit — Safari, Onyx for Mac's web view — keeps a replaced entry where it
 * was in the line. The count of new pictures does not move, so a picture put
 * again ages only as new ones come in.
 */
async function toBack(queue, key) {
  queue.moved?.add(key);
  const cache = await caches.open(queue.name);
  const copy = await cache.match(key, { ignoreVary: true });
  // Gone, or put again already by a hit answered just before this one.
  if (!copy || !stale(queue, stampOf(copy))) return;
  await cache.delete(key);
  try {
    await cache.put(key, stamped(copy, queue.kept));
  } catch (err) {
    if (queue.held !== null) queue.held -= 1;
    throw err;
  }
}

/** Read the line and trim it to its cap, one read at a time: a call while one is under way waits for that one. Never rejects. */
function trim(queue) {
  if (!queue.trimming) queue.trimming = readAndTrim(queue).catch(() => {}).then(() => { queue.trimming = null; });
  return queue.trimming;
}

async function readAndTrim(queue) {
  const cache = await caches.open(queue.name);
  // A picture on its way to the back may be listed at its old place, at the
  // front, and be at the back by the time the deletes reach it, so it is not
  // taken: one already on its way when this begins to read the line, and one
  // set off while it runs.
  const moved = new Set(queue.moving.keys());
  queue.moved = moved;
  try {
    const keys = await cache.keys();
    // A picture kept in the other cache's place — a poster among the
    // thumbnails, from before the two were kept apart — is never looked for
    // here again, so it goes too.
    const line = [];
    const stray = [];
    for (const k of keys) {
      if (k.url === TALLY) continue;
      (previewCacheName(k.url) === queue.name ? line : stray).push(k);
    }
    const doomed = trimPlan(line, queue.max, queue.to);
    let taken = 0;
    const gone = [...stray, ...doomed];
    for (let i = 0; i < gone.length; i += DELETES_AT_ONCE) {
      const now = gone.slice(i, i + DELETES_AT_ONCE).filter((k) => !moved.has(k.url) && !queue.moving.has(k.url));
      await Promise.all(now.map((k) => cache.delete(k)));
      taken += now.filter((k) => previewCacheName(k.url) === queue.name).length;
    }
    queue.held = line.length - taken;
  } finally {
    queue.moved = null;
  }
  await save(queue);
}
