/**
 * First pages of file listings, kept in memory for the session, so opening a
 * folder you have seen — or one you are pointing at (FilesClient prefetches
 * on hover) — shows its files at once instead of after a round trip.
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
 */
export function listingKey({ filespaceId = '', folder = '', query = '', kinds = [], sort = 'new' } = {}) {
  return JSON.stringify([
    String(filespaceId || ''),
    String(folder || ''),
    String(query || '').trim(),
    [...(kinds || [])].map(String).sort(),
    String(sort || 'new'),
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
