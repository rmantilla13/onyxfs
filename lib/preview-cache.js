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
// keepsResponse, trimPlan and the names), and test/preview-cache.test.js
// runs that file against these and fails when the two disagree.
//
// A kept preview is a picture of someone's library on this disk, so the
// cache goes with the session: the account menu and the command palette
// clear it before signing out, and the sign-in page clears it for a session
// that ended any other way (clearPreviewCaches).

import { isThumbKey, isThumbSiblingKey, isPosterKey, isFilmstripKey } from './media.js';

/** The worker's script, served from /public; its scope is the whole site. */
export const PREVIEW_WORKER_URL = '/thumb-sw.js';
/** The cache it keeps previews in. A new version renames it and drops the old one. */
export const PREVIEW_CACHE = 'previews-v1';
/** What every version's cache name starts with, so all of them can be cleared. */
export const PREVIEW_CACHE_PREFIX = 'previews-';
/**
 * At most this many previews are kept, the oldest dropped first. Most are
 * grid thumbnails and their siblings, tens of kilobytes each; a poster or a
 * filmstrip is a few hundred.
 */
export const PREVIEW_CACHE_MAX = 4000;
/** A trim leaves this many, so a full cache is trimmed once every few hundred pictures rather than on each. */
export const PREVIEW_CACHE_TRIM_TO = 3600;

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
 * The keys to delete once more than `max` are kept: the oldest (Cache
 * Storage lists them in the order they were put), enough to leave `to`.
 */
export function trimPlan(keys, max = PREVIEW_CACHE_MAX, to = PREVIEW_CACHE_TRIM_TO) {
  const list = Array.isArray(keys) ? keys : [];
  return list.length > max ? list.slice(0, list.length - Math.min(to, max)) : [];
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
 * Delete every version of the preview cache in this browser. Resolves once
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
