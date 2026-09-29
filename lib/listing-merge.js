// lib/listing-merge.js — fold a refreshed first page into what is loaded.
//
// While an upload batch runs, the files page refreshes its first page every
// second or so, so new tiles appear as they land. Replacing the listing with
// that page threw away every page scrolled into below it: someone three
// hundred files down was put back to the first hundred, every second.
//
// Merging keeps them. The fresh page comes first — new rows in their sorted
// place, changed rows as they are now — and every loaded row it does not
// hold follows in the order it was loaded: a row pushed off page one by the
// new ones is still there, still in order. The cursor stays the one for the
// end of what is loaded, since that is still the end.
//
// For refreshes after uploads only: a delete or a move reloads outright.

/**
 * `loaded` = { files, cursor } on screen; `page` = { files, cursor } just
 * fetched from the top. Returns { files, cursor }.
 */
export function mergeFirstPage(loaded, page) {
  const fresh = Array.isArray(page?.files) ? page.files : [];
  const have = Array.isArray(loaded?.files) ? loaded.files : [];
  const ids = new Set(fresh.map((f) => f?.id));
  const rest = have.filter((f) => f && !ids.has(f.id));
  if (!rest.length) return { files: fresh, cursor: page?.cursor || null };
  return { files: [...fresh, ...rest], cursor: loaded?.cursor || null };
}

/**
 * Keep the loaded row objects that did not change, so a memoized card for
 * them does not re-render: same id and same `version`, `seq`, thumbnail and
 * sibling URLs → the old object. The proxy's URL counts too: a streamable
 * copy that finished since leaves the row's `seq` alone (it is not a column
 * on `files`), and keeping the old object would keep Quick Look off it.
 */
export function keepUnchanged(prev, next) {
  const byId = new Map((prev || []).map((f) => [f?.id, f]));
  return (next || []).map((f) => {
    const old = byId.get(f?.id);
    if (!old) return f;
    const same = old.version === f.version && old.seq === f.seq && old.name === f.name
      && old.thumbnailUrl === f.thumbnailUrl && old.smUrl === f.smUrl && old.xsUrl === f.xsUrl
      && old.posterUrl === f.posterUrl && old.url === f.url && old.proxyUrl === f.proxyUrl
      && old.reviewStatus === f.reviewStatus && old.openComments === f.openComments;
    return same ? old : f;
  });
}
