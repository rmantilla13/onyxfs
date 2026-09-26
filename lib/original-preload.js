// lib/original-preload.js — an original fetched ahead, the way the fill-in
// needs it.
//
// An image with no large preview is shown from its original, and a writer's
// browser hands that same download to the fill-in, which makes the preview
// from it (lib/thumbnail-client.js). That download is a CORS fetch, never
// from the HTTP cache: a canvas must not be tainted, and an original's key
// can be reused after a delete, so a cached copy may be another file's
// bytes (and one an <img> put there carries no CORS headers, which is a
// failed fetch).
//
// Quick Look loads its neighbours ahead. For a file the fill-in wants, an
// <img> preload would be a download the fill-in cannot use — so stepping
// onto a preloaded neighbour made no preview, and one still loading made
// the fetch fail. Such a neighbour is fetched here instead, as a blob, and
// decoded; ProgressiveImage takes it (with its object URL, already decoded)
// when the item is shown, and hands the blob on as if it had fetched it.

const MAX = 3;
const entries = new Map(); // src → { promise, ctrl, objectUrl }

function release(e) {
  e.released = true;
  try { e.ctrl?.abort(); } catch {}
  if (e.objectUrl) URL.revokeObjectURL(e.objectUrl);
  e.objectUrl = null;
}

/** Fetch and decode `src` ahead; resolves { blob, objectUrl }. At most MAX are kept; the oldest go first. */
export function preloadOriginal(src) {
  if (!src || typeof fetch !== 'function') return null;
  const had = entries.get(src);
  if (had) return had.promise;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const e = { ctrl, objectUrl: null, promise: null };
  e.promise = fetch(src, { mode: 'cors', cache: 'no-store', signal: ctrl?.signal })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); })
    .then(async (blob) => {
      if (e.released) throw new Error('released');
      e.objectUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.decoding = 'async';
      img.src = e.objectUrl;
      await (img.decode ? img.decode() : Promise.resolve());
      return { blob, objectUrl: e.objectUrl };
    });
  e.promise.catch(() => { if (entries.get(src) === e) { entries.delete(src); release(e); } });
  entries.set(src, e);
  while (entries.size > MAX) {
    const [oldest, old] = entries.entries().next().value;
    entries.delete(oldest);
    release(old);
  }
  return e.promise;
}

/**
 * The preload of `src`, if there is one, handed over as { promise, putBack }:
 * once the caller uses what `promise` resolves to, it owns the object URL
 * (and revokes it); `putBack()` returns an unused one (an effect cleaned up
 * before it got there). Null when nothing was preloaded.
 */
export function takePreloaded(src) {
  const e = entries.get(src);
  if (!e) return null;
  entries.delete(src);
  return {
    promise: e.promise,
    putBack: () => { if (!e.released && !entries.has(src)) entries.set(src, e); },
  };
}

/** Let go of a preload no longer wanted (stepped away from). */
export function dropPreloaded(src) {
  const e = entries.get(src);
  if (!e) return;
  entries.delete(src);
  release(e);
}

/** Whether `src` is being or has been preloaded here. */
export function isPreloading(src) {
  return entries.has(src);
}
