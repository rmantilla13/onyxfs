// lib/preview-cache.js — the preview worker (public/thumb-sw.js): what it
// keeps, under what, and the page's side of it.
//
// A preview — a thumbnail, its sm and xs siblings, a player poster, a
// filmstrip — is stored once under a key the server names, and the bytes
// under that key never change (lib/media.js). Its address does:
// presignFileUrls signs previews on a day's window, phased per key, so a
// picture seen yesterday has a new URL today, and the browser's cache, keyed
// by the whole URL, downloads it again. The worker keeps each preview under
// what does not change — the bucket's origin and the key's path, with the
// signature cut off — so a picture seen once is read from disk on every
// later visit.
//
// The worker is a static file the bundler never sees, so it cannot import
// this module. It carries its own copy of the rules here (previewCacheKey,
// previewCacheName, keepsResponse, trimPlan, refreshes and the names), and
// test/preview-cache.test.js runs that file against these and fails when the
// two disagree.
//
// Previews are kept in two caches by size, each with a cap on how many it
// holds: grid thumbnails and their siblings, tens of kilobytes each, in one;
// posters and filmstrips, a few hundred kilobytes, in the other. One count
// for both made the cache anything from a fifth of a gigabyte to two,
// depending on which kind someone looked at most. Each cache is a line: what
// is kept goes to the back, a trim takes from the front, and a picture seen
// again once enough new ones have come in after it is put again, to the back
// — so what is used is what stays.
//
// A kept preview is a picture of someone's library on this disk, so the
// cache goes with the session: the account menu and the command palette
// clear it before signing out, and the sign-in page clears it for a session
// that ended any other way (clearPreviewCaches).

import { isThumbKey, isThumbSiblingKey, isPosterKey, isFilmstripKey } from './media.js';

/** The worker's script, served from /public; its scope is the whole site. */
export const PREVIEW_WORKER_URL = '/thumb-sw.js';
/** The cache it keeps grid thumbnails and their sm and xs siblings in. A new version renames it and drops the old one. */
export const PREVIEW_CACHE = 'previews-v1';
/** The cache it keeps posters (an image's large preview too) and filmstrips in. Renamed and dropped the same way. */
export const PREVIEW_LARGE_CACHE = 'previews-large-v1';
/** What every version's cache name starts with, both caches', so all of them can be cleared. */
export const PREVIEW_CACHE_PREFIX = 'previews-';
/** At most this many thumbnails and siblings are kept, tens of kilobytes each. */
export const PREVIEW_CACHE_MAX = 4000;
/** A trim leaves this many, so a full cache is trimmed once every few hundred pictures rather than on each. */
export const PREVIEW_CACHE_TRIM_TO = 3600;
/**
 * At most this many posters and filmstrips are kept. An image's poster is its
 * 2400-pixel preview, 300 to 500 KB (lib/poster.js), so this is about 400 MB
 * at most, next to a couple of hundred for the thumbnails. It is sized for
 * Quick Look: stepping again through a shoot of several hundred photos reads
 * every one from disk. Stepping in order through more than the cap downloads
 * each one every time, as it would with any cache that keeps what was used
 * last.
 */
export const PREVIEW_LARGE_CACHE_MAX = 1000;
/** As PREVIEW_CACHE_TRIM_TO, for the posters and filmstrips. */
export const PREVIEW_LARGE_CACHE_TRIM_TO = 900;

/** One of the previews the server names (lib/media.js) — never a proxy, never an original. */
export function isPreviewKey(key) {
  return isThumbKey(key) || isThumbSiblingKey(key) || isPosterKey(key) || isFilmstripKey(key);
}

/**
 * What a request is kept under: the URL's origin and path, without the
 * query that carries the signature — or null when it is not the worker's to
 * answer, which is anything but a GET of a preview on another origin.
 *
 * Previews live under `_thumbs/` at the bucket root, so the key is the whole
 * path (virtual-hosted, `/_thumbs/<uuid>.webp`) or the path after one
 * segment, the bucket (path-style, as B2 and every custom endpoint is
 * signed). A `_thumbs` folder deeper down is someone's files, which can
 * change, and is never kept. `ownOrigin` is the site's own: its routes are
 * never the worker's.
 */
export function previewCacheKey({ url, method = 'GET', mode = 'no-cors' } = {}, ownOrigin = '') {
  if (method !== 'GET' || mode === 'navigate') return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin === ownOrigin) return null;
  const m = /^(?:\/[^/]+)?\/(_thumbs\/[^/]+)$/.exec(u.pathname);
  return m && isPreviewKey(m[1]) ? `${u.origin}${u.pathname}` : null;
}

/**
 * Whether an answer is one to keep: a picture that came back whole, over
 * CORS. Never an opaque answer — an <img> asks without CORS, and Chrome
 * counts each opaque response in Cache Storage as megabytes of padding
 * against the quota — nor an error, a redirect, or anything not an image.
 */
export function keepsResponse(res) {
  return !!res && res.ok === true && res.type === 'cors' && !res.redirected
    && /^image\//i.test(res.headers?.get?.('content-type') || '');
}

/**
 * The cache a preview is kept in, by the key previewCacheKey gave it: a
 * poster or a filmstrip in PREVIEW_LARGE_CACHE, every other preview in
 * PREVIEW_CACHE. Null for a key that is not a preview's.
 */
export function previewCacheName(cacheKey) {
  let path;
  try { path = new URL(cacheKey).pathname; } catch { return null; }
  const m = /^(?:\/[^/]+)?\/(_thumbs\/[^/]+)$/.exec(path);
  if (!m || !isPreviewKey(m[1])) return null;
  return isPosterKey(m[1]) || isFilmstripKey(m[1]) ? PREVIEW_LARGE_CACHE : PREVIEW_CACHE;
}

/**
 * The keys to delete once more than `max` are kept: the front of the line
 * (Cache Storage lists them in the order they were put, and one put again
 * goes to the back), enough to leave `to`.
 */
export function trimPlan(keys, max = PREVIEW_CACHE_MAX, to = PREVIEW_CACHE_TRIM_TO) {
  const list = Array.isArray(keys) ? keys : [];
  return list.length > max ? list.slice(0, list.length - Math.min(to, max)) : [];
}

/**
 * Whether a kept preview, seen again, is put again so that it goes to the
 * back of the line: once `since` — how many new previews have been kept after
 * it — is half as many as a trim leaves (`to`). Only new previews count, not
 * ones put again, so a picture put again is not put again until that many
 * more have come in, and seeing the same pictures over and over writes
 * nothing. Half, so that a folder opened every so often is seen at least once
 * in the stretch where it is put again, however many new previews come in
 * between, short of about what a trim leaves. A cache that has not had that
 * many come in has nothing old enough.
 */
export function refreshes(since, to = PREVIEW_CACHE_TRIM_TO) {
  return Number.isInteger(since) && Number.isInteger(to) && to > 0 && since * 2 >= to;
}

/**
 * Install the worker, once the page has loaded so it never competes with
 * the page's own requests. Where there are no service workers — some
 * private windows, a web view that has them off — or registering fails,
 * nothing happens and pictures load as they always have. Onyx for Mac's
 * web view may well have them; its sign-out removes every kind of website
 * data (WebController.signOut), the worker and its cache included.
 *
 * An installed worker is asked for an update on every page load: that is
 * what carries a replacement (the kill switch in public/thumb-sw.js) to a
 * browser at its next visit rather than whenever it next checks by itself.
 *
 * Never throws: it runs in an effect in the root layout, where an error
 * would take the page down with it.
 */
export function registerPreviewWorker({
  nav = globalThis.navigator, win = globalThis.window, doc = globalThis.document,
} = {}) {
  try {
    // Reading it throws in a sandboxed document.
    const sw = nav?.serviceWorker;
    if (!sw || typeof sw.register !== 'function' || !win || !doc) return;
    const go = () => {
      try {
        sw.register(PREVIEW_WORKER_URL, { scope: '/' })
          .then((reg) => (reg?.active ? reg.update() : undefined))
          .catch(() => {});
      } catch { /* no worker: pictures load as they always have */ }
    };
    if (doc.readyState === 'complete') go();
    else win.addEventListener('load', go, { once: true });
  } catch { /* as above */ }
}

/**
 * Delete every version of both preview caches in this browser. Resolves once
 * done or after `timeoutMs`, whichever is first — signing out never waits on
 * a slow disk — and never throws or rejects. `store` is Cache Storage
 * (`caches`, which throws on reading in a sandboxed document).
 */
export function clearPreviewCaches({ store, timeoutMs = 1500 } = {}) {
  let work;
  try {
    const caches = store === undefined ? globalThis.caches : store;
    if (!caches || typeof caches.keys !== 'function') return Promise.resolve();
    work = caches.keys()
      .then((names) => Promise.all(names.filter((n) => String(n).startsWith(PREVIEW_CACHE_PREFIX)).map((n) => caches.delete(n))))
      .catch(() => {});
  } catch {
    return Promise.resolve();
  }
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  return Promise.race([work, late]).then(() => { clearTimeout(timer); });
}
