// lib/thumb-observer.js — one IntersectionObserver for every tile that wants
// something made for it once it is near the screen.
//
// A tile that has no thumbnail, or a thumbnail without its smaller siblings,
// asks the backfill queue (lib/thumbnail-client.js) for one — but only once it
// comes near the viewport, so opening a folder of thousands does not queue
// thousands. Each tile used to make an IntersectionObserver of its own; a
// scroll through a big folder made and dropped hundreds. This is one observer
// shared by all of them, with a callback per element that runs once.
//
// Browser only; outside one (the server render) `watch` does nothing.

const MARGIN = '200px';
let io = null;
const callbacks = new WeakMap();

function observer() {
  if (io || typeof IntersectionObserver === 'undefined') return io;
  io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const fn = callbacks.get(e.target);
      callbacks.delete(e.target);
      io.unobserve(e.target);
      if (fn) {
        try { fn(); } catch { /* a tile's request is its own business */ }
      }
    }
  }, { rootMargin: MARGIN });
  return io;
}

/**
 * Call `fn` once, the first time `el` comes within MARGIN of the viewport.
 * Returns a function that stops watching (a tile unmounted or no longer
 * needs anything). Watching the same element again replaces its callback.
 */
export function watch(el, fn) {
  const o = observer();
  if (!o || !el || typeof fn !== 'function') return () => {};
  callbacks.set(el, fn);
  o.observe(el);
  return () => {
    if (callbacks.get(el) === fn) {
      callbacks.delete(el);
      o.unobserve(el);
    }
  };
}
