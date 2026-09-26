// lib/original-preload.js — an original fetched ahead, the way the fill-in
// needs it.
//
// An image with no large preview is shown from its original, and a writer's
// browser hands that same download to the fill-in, which makes the preview
// from it (lib/thumbnail-client.js). That download is a CORS fetch past the
// HTTP cache (ProgressiveImage's fetchBlob). Quick Look loads its neighbours
// ahead; an <img> preload of such an original was a download the fill-in
// could not use — stepping onto it made no preview — and a copy the fetch
// could not read. So such a neighbour is fetched here, the same way, and
// ProgressiveImage takes the blob (`preloaded`) instead of fetching again.

const MAX = 3;
const entries = new Map(); // src → { promise, ctrl }

/** Fetch `src` ahead as a blob. At most MAX are kept; the oldest go first. */
export function preloadOriginal(src) {
  if (!src || typeof fetch !== 'function') return null;
  if (entries.has(src)) return entries.get(src).promise;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const promise = fetch(src, { mode: 'cors', cache: 'no-store', signal: ctrl?.signal })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); });
  promise.catch(() => { if (entries.get(src)?.promise === promise) entries.delete(src); });
  entries.set(src, { promise, ctrl });
  while (entries.size > MAX) dropPreloaded(entries.keys().next().value);
  return promise;
}

/** The blob being or already fetched for `src`, or null. */
export function preloaded(src) {
  return entries.get(src)?.promise || null;
}

/** Let go of a preload no longer wanted (stepped away from). */
export function dropPreloaded(src) {
  const e = entries.get(src);
  if (!e) return;
  entries.delete(src);
  try { e.ctrl?.abort(); } catch {}
}
