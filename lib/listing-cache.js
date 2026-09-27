/**
 * File listings, kept in memory for the session, so opening a folder you have
 * seen — or one you are pointing at (FilesClient prefetches on hover) — shows
 * its files at once instead of after a round trip. Every page loaded is kept
 * with its listing (`extend`), so coming back to a folder you had scrolled
 * deep into brings back all of it, not the first hundred.
 *
 * An entry younger than FRESH_MS is shown as it is. An older one, up to
 * KEEP_MS, is shown and refetched quietly behind it (stale-while-revalidate).
 * Past KEEP_MS it is dropped: the rows carry presigned URLs, and this keeps
 * well inside their lifetime. Anything that changes files clears the lot —
 * a clean refetch is cheaper to reason about than knowing which folders a
 * move touched.
 *
 * Client-safe and pure apart from the clock, which is injectable for tests.
 */

export const FRESH_MS = 30_000;
export const KEEP_MS = 5 * 60_000;
const MAX_ENTRIES = 60;

/**
 * What a listing is, as a key: the same inputs give the same key on the
 * server (the files page renders the first page) and in the browser.
 * `flat` is a view's Flatten directories: every folder beneath the open one
 * in one listing. A search looks beneath the folder whether or not it is set
 * (lib/views.js isRecursive), so the two spell the same listing then.
 */
export function listingKey({ filespaceId = '', folder = '', query = '', kinds = [], sort = 'new', flat = false } = {}) {
  const q = String(query || '').trim();
  return JSON.stringify([
    String(filespaceId || ''),
    String(folder || ''),
    q,
    [...(kinds || [])].map(String).sort(),
    String(sort || 'new'),
    flat || q ? 1 : 0,
  ]);
}

export function createListingCache({ now = () => Date.now(), max = MAX_ENTRIES } = {}) {
  const entries = new Map(); // insertion order is recency: oldest first
  return {
    /** { files, cursor, fresh } or null. A hit counts as a use. */
    get(key) {
      const e = entries.get(key);
      if (!e) return null;
      const age = now() - e.at;
      entries.delete(key);
      if (age > KEEP_MS) return null;
      entries.set(key, e);
      return { files: e.files, cursor: e.cursor, fresh: age < FRESH_MS };
    },
    set(key, { files, cursor = null }) {
      entries.delete(key);
      entries.set(key, { files, cursor, at: now() });
      while (entries.size > max) entries.delete(entries.keys().next().value);
    },
    /**
     * More of a listing than its first page — the pages scrolled into since
     * — without making it any fresher: its age is still its first page's.
     * Nothing for a listing that is not cached (or no longer is).
     */
    extend(key, { files, cursor = null }) {
      const e = entries.get(key);
      if (!e || now() - e.at > KEEP_MS) return false;
      e.files = files;
      e.cursor = cursor;
      return true;
    },
    /** Young enough that fetching it again would be waste. */
    isFresh(key) {
      const e = entries.get(key);
      return !!e && now() - e.at < FRESH_MS;
    },
    clear() { entries.clear(); },
    get size() { return entries.size; },
  };
}

/** The one the files page uses: module-level, so it outlives the page component (a file's page and back). */
export const listingCache = createListingCache();

/**
 * What the files page was showing when it opened a file — which listing,
 * scrolled where, with what selected — so ← Back from the file brings it back
 * as it was left rather than at the top of its first page. One at a time, in
 * memory (the rows carry signed URLs), taken once, and only within KEEP_MS.
 */
export function createReturnSlot({ now = () => Date.now() } = {}) {
  let slot = null;
  return {
    save(state) { slot = state ? { ...state, at: now() } : null; },
    /**
     * The saved state if it is for `where` ({ filespaceId, folder }) and
     * recent, else null. Not used up: React may call a state initializer
     * twice, and both calls must see it. `clear` uses it up.
     */
    match({ filespaceId = '', folder = '' } = {}) {
      const s = slot;
      if (!s || now() - s.at > KEEP_MS) return null;
      if (String(s.filespaceId || '') !== String(filespaceId || '') || String(s.folder || '') !== String(folder || '')) return null;
      return s;
    },
    /** `match`, and used up either way. */
    take(where) {
      const s = this.match(where);
      slot = null;
      return s;
    },
    clear() { slot = null; },
    peek() { return slot; },
  };
}

export const returnSlot = createReturnSlot();
