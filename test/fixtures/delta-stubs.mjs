// Stand-in for lib/db.js, for test/delta-folders-tag.test.js: the store of
// test/fixtures/mac-writes-stubs.mjs (people, tokens, drives, grants — the
// desktop guard and getPrincipal run for real on it), and the sync feed's
// own reads over the same store, in globalThis.__mw.
//
// The feed's rows are test/sync-feed.test.js's and the database tests'
// business; here a page is empty, and what is looked at is the folder list
// that rides along with it. `listSyncFolders` narrows a library's folders to
// the caller's grants as the real one does, so two callers can be handed two
// different lists.

export * from './mac-writes-stubs.mjs';

const s = () => globalThis.__mw;

export async function listFileChanges({ cursor = 0 } = {}) {
  return { changed: [], deleted: [], cursor: Math.max(Number(cursor) || 0, s().seq), done: true };
}
export async function currentChangeCursor() { return s().seq; }
export async function changeHorizon() { return undefined; }

/** The scope's folders: `syncFolders[prefix]`, '' for the library's. */
export async function listSyncFolders(principal = {}, { storagePrefix } = {}) {
  s().folderReads = (s().folderReads || 0) + 1;
  const sp = storagePrefix ? String(storagePrefix).replace(/^\/+|\/+$/g, '') : '';
  const names = [...(s().syncFolders?.[sp] || [])];
  if (sp || principal.isAdmin) return names;
  const grants = Array.isArray(principal.folderGrants) ? principal.folderGrants : [];
  return names.filter((n) => grants.some((g) => g === '' || n === g || n.startsWith(`${g}/`)));
}
