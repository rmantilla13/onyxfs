// lib/quicklook.js — what Quick Look steps through, and what it loads ahead.
//
// Pure, so the rules are tested apart from the overlay
// (app/components/quicklook/QuickLook.js):
//
//   items     with more than one item selected, the selection in view
//             order, and stepping moves only Quick Look; otherwise every
//             folder and file shown, and stepping moves the selection too,
//             as Finder's does
//   preload   after the current picture is sharp: the previews of the next,
//             the previous and the one after next in the direction of travel
//   keep      decoded pictures for the current item ±1 (±2 on a phone): a
//             2560px preview is ~17 MB decoded, so no more than that

/** Keys in view order → `{ keys, follow }`. `follow`: stepping moves the selection. */
export function quickLookItems({ order = [], selected = new Set(), start = null } = {}) {
  const sel = selected instanceof Set ? selected : new Set(selected || []);
  if (sel.size > 1) {
    const keys = order.filter((k) => sel.has(k));
    return { keys, follow: false, index: Math.max(0, start != null ? keys.indexOf(start) : 0) };
  }
  const index = start != null ? order.indexOf(start) : sel.size === 1 ? order.indexOf([...sel][0]) : 0;
  return { keys: [...order], follow: true, index: Math.max(0, index) };
}

/**
 * The index a step lands on: clamped to the ends, never wrapping. At the last
 * item with more to load (`more`), the answer says so, and the caller loads
 * the next page before stepping.
 */
export function stepIndex(index, delta, count, { more = false } = {}) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (!n) return { index: 0, load: false };
  const at = Math.min(n - 1, Math.max(0, Math.floor(Number(index) || 0)));
  const want = at + Math.sign(Number(delta) || 0);
  if (want >= n) return { index: n - 1, load: !!more };
  return { index: Math.max(0, want), load: false };
}

/**
 * Indices to preload after `index`, nearest first: next and previous, then
 * one more in the direction of travel (`dir` +1 or -1). Only indices inside
 * the list, and never `index` itself.
 */
export function preloadPlan(index, count, dir = 1) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const d = dir < 0 ? -1 : 1;
  const out = [];
  for (const i of [index + d, index - d, index + 2 * d]) {
    if (i >= 0 && i < n && i !== index && !out.includes(i)) out.push(i);
  }
  return out;
}

/** Whether a decoded picture for `i` may be held while `index` is shown. */
export function keepDecoded(i, index, { phone = false } = {}) {
  return Math.abs(i - index) <= (phone ? 2 : 1);
}

/** What a preload of `file` fetches, or null: its preview, or — near, small and on a fast connection — its original. */
export function preloadUrl(file, { distance = 1, fast = false, maxOriginalBytes = 12 * 1024 * 1024 } = {}) {
  if (!file) return null;
  if (file.posterUrl) return file.posterUrl;
  if (distance <= 1 && fast && file.url && Number(file.size || 0) > 0 && Number(file.size) <= maxOriginalBytes) return file.url;
  return null;
}

/** "3 of 265", or "3 of 265+" while more can be loaded. */
export function positionLabel(index, count, more = false) {
  if (!count) return '';
  return `${index + 1} of ${count.toLocaleString('en-US')}${more ? '+' : ''}`;
}
