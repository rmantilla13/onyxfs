/**
 * Where the admin panel's old addresses now go. The panel used to be one
 * page with tabs (/admin?tab=…) and the storage report lived at /storage;
 * both are still linked from the Mac app's Go menu, old bookmarks and Slack
 * messages, so they redirect rather than 404. Pure, so the map is tested.
 */

/** /admin?tab=<key> → the section that replaced the tab. */
export const LEGACY_ADMIN_TABS = Object.freeze({
  storage: '/admin/storage',
  filespaces: '/admin/drives',
  drives: '/admin/drives',
  access: '/admin/requests',
  health: '/admin/health',
});

/** The old storage pages → where they moved inside the panel. */
export const LEGACY_STORAGE_PATHS = Object.freeze({
  '/storage': '/admin/usage',
  '/storage/duplicates': '/admin/usage/duplicates',
});

/** The section for an old `?tab=` value, or null when there is nothing to redirect. */
export function legacyAdminTab(tab) {
  const key = String(Array.isArray(tab) ? tab[0] : tab ?? '').trim().toLowerCase();
  return Object.hasOwn(LEGACY_ADMIN_TABS, key) ? LEGACY_ADMIN_TABS[key] : null;
}

/**
 * Where a request for the old tabbed panel goes, or null: /admin?tab=<key>
 * → the section, keeping any other query (the tab itself is dropped, so
 * the address is the section's own). Read by middleware.js, so the
 * redirect is a real 307 before anything renders — this module imports
 * nothing and is Edge-safe.
 */
export function legacyAdminUrl(pathname, search = '') {
  const p = String(pathname || '').replace(/\/+$/, '') || '/';
  if (p !== '/admin') return null;
  const params = new URLSearchParams(String(search || ''));
  const to = legacyAdminTab(params.getAll('tab'));
  if (!to) return null;
  params.delete('tab');
  const q = params.toString();
  return q ? `${to}?${q}` : to;
}

/**
 * The new address for an old storage path, keeping any query string (a
 * trailing slash is the same page). Null when the path is not one of them.
 */
export function legacyStoragePath(pathname, search = '') {
  const p = String(pathname || '').replace(/\/+$/, '') || '/';
  const to = Object.hasOwn(LEGACY_STORAGE_PATHS, p) ? LEGACY_STORAGE_PATHS[p] : null;
  if (!to) return null;
  const q = String(search || '');
  return q && q !== '?' ? `${to}${q.startsWith('?') ? q : `?${q}`}` : to;
}
