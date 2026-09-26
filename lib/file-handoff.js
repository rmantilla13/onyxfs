// lib/file-handoff.js — what the files view hands to the file it opens.
//
// Opening a file used to show nothing until the server had rendered its page
// and the browser had downloaded the original: 1.3 s to first pixels, 2.6 s
// to a sharp picture on a fast 4G connection. The files view already holds
// everything needed to paint that page — the row, and a decoded thumbnail on
// screen — so it hands them over:
//
//   handoff      id → { row, currentSrc, natural }: the listing's row (its
//                signed URLs included), the picture the tile was showing and
//                its decoded size. In memory only, for this document: signed
//                URLs are never written anywhere that outlives the tab.
//   ready URLs   pictures this document has decoded. A viewer mounting with
//                one of them starts from it at once (the memory cache paints
//                it in the same frame) instead of from a blurrier layer.
//   return       { href, listingKey, fileId, at } in sessionStorage, so the
//                file page's ← Back can go back through history — to the
//                listing as it was left — rather than load the folder afresh.
//
// Browser only, apart from the pure helpers the tests use.

const MAX_HANDOFFS = 20;
const handoffs = new Map();
const ready = new Set();
const MAX_READY = 400;
const RETURN_KEY = 'onyx.files.return';
// A return older than this is from another visit: Back loads the folder.
const RETURN_MS = 6 * 60 * 60 * 1000;

/** Keep what the page needs to paint `id` before the server answers. */
export function setHandoff(id, { row, currentSrc = null, natural = null } = {}) {
  if (id == null || !row) return;
  const key = String(id);
  handoffs.delete(key);
  handoffs.set(key, { row, currentSrc, natural, at: Date.now() });
  while (handoffs.size > MAX_HANDOFFS) handoffs.delete(handoffs.keys().next().value);
}

/** What was handed over for `id`, or null. */
export function getHandoff(id) {
  return id == null ? null : handoffs.get(String(id)) || null;
}

/** A picture this document has decoded (a tile, a preview, an original). */
export function markReady(url) {
  if (!url || typeof url !== 'string') return;
  ready.delete(url);
  ready.add(url);
  while (ready.size > MAX_READY) ready.delete(ready.values().next().value);
}

export function isReady(url) {
  return !!url && ready.has(url);
}

/**
 * The index of the sharpest layer that can be shown at once: the highest one
 * whose picture is already decoded in this document, else the first.
 */
export function firstLayer(layers, readyFn = isReady) {
  const list = Array.isArray(layers) ? layers : [];
  for (let i = list.length - 1; i > 0; i--) if (list[i]?.src && readyFn(list[i].src)) return i;
  return 0;
}

function storage() {
  try { return typeof window !== 'undefined' ? window.sessionStorage : null; } catch { return null; }
}

/** Note that the files view at `href` opened `fileId`. */
export function rememberReturn({ href, listingKey, fileId }) {
  try { storage()?.setItem(RETURN_KEY, JSON.stringify({ href, listingKey, fileId: String(fileId), at: Date.now() })); } catch {}
}

/** The files view that opened `fileId`, if that is how it was reached (and recently). */
export function returnFor(fileId, { now = Date.now(), read } = {}) {
  let r = null;
  try { r = JSON.parse((read ? read() : storage()?.getItem(RETURN_KEY)) || 'null'); } catch { r = null; }
  if (!r || String(r.fileId) !== String(fileId) || !(now - Number(r.at) < RETURN_MS)) return null;
  return r;
}
