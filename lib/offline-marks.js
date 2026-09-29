/**
 * What Onyx for Mac keeps offline, as the files page marks it.
 *
 * The app tells the page two things (WebController.publishOfflineState):
 * `pinned`, the ids of every file it keeps — chosen one by one, or inside a
 * folder or drive it keeps — and `pinnedFolders`, the folders and drives
 * chosen, as `{ scope, path }` with '' for a whole drive. A file inside a
 * kept folder reaches `pinned` only once the app has listed that folder,
 * which for a drive it had not opened is after fetching it; the folder
 * itself is known at once. So a file is marked when either says so: kept by
 * id, or in a kept folder of its own drive.
 *
 * Scopes are the app's names: "drive.<id>", or "library" for files in no
 * drive. On a drive's page every file is that drive's. On All files a
 * file's drive is the one its storage key is under (drivesHolding), so a
 * folder kept in one drive never marks a folder of the same name elsewhere.
 *
 * Pure, and safe for the client: the page builds one of these each time
 * what the app keeps changes, and every card and row asks it.
 */
import { drivesHolding } from './drive-access.js';

/** The app's name for a drive's files: "drive.<id>", or "library" for files in no drive. */
export const scopeOf = (driveId) => (driveId ? `drive.${driveId}` : 'library');

/**
 * The kept folder at or above `path` in `scope`: the nearest one's path,
 * '' when it is the whole drive, or null when nothing above it is kept.
 */
export function keptFolderAbove(pinnedFolders, scope, path) {
  const at = String(path || '');
  let nearest = null;
  for (const rule of pinnedFolders || []) {
    if (rule?.scope !== scope || typeof rule.path !== 'string') continue;
    const p = rule.path;
    // A folder boundary, not a prefix of the name: "Day 1" keeps nothing in "Day 10".
    const covers = p === '' || at === p || at.startsWith(`${p}/`);
    if (covers && (nearest === null || p.length > nearest.length)) nearest = p;
  }
  return nearest;
}

/**
 * The marks for one page. `driveId` is the drive the page is showing ('' or
 * null for All files); `drives` the viewer's drives with their prefixes.
 *
 *   file(f)       whether the file is kept
 *   fileKeptBy(f) the kept folder that keeps it, as { scope, path } with ''
 *                 for its whole drive; null when nothing but its own choice does
 *   folder(path)  { kept, by }: kept itself (by === path) or inside a kept
 *                 folder of the page's drive (by, its path)
 *   drive(id)     whether a whole drive is kept ('' or null: the files in no drive)
 */
export function offlineMarks({ pinned, pinnedFolders = [], driveId = null, drives = [] } = {}) {
  const ids = pinned instanceof Set ? pinned : new Set(pinned || []);
  const rules = Array.isArray(pinnedFolders) ? pinnedFolders : [];
  const pageScope = scopeOf(driveId);

  // The scopes whose kept folders may hold a file: the page's drive, or on
  // All files the drives its key is under — both, for a drive inside another.
  const scopesOf = (f) => {
    if (driveId) return [pageScope];
    const holding = drivesHolding(f?.storageKey, drives);
    return holding.length ? holding.map((d) => scopeOf(d.id)) : ['library'];
  };

  const fileKeptBy = (f) => {
    if (!rules.length || !f) return null;
    for (const scope of scopesOf(f)) {
      const path = keptFolderAbove(rules, scope, f.folder);
      if (path !== null) return { scope, path };
    }
    return null;
  };

  return {
    any: ids.size > 0 || rules.length > 0,
    file: (f) => !!f && (ids.has(f.id) || fileKeptBy(f) !== null),
    fileKeptBy,
    folder: (path) => {
      const by = keptFolderAbove(rules, pageScope, path);
      return { kept: by !== null, by };
    },
    drive: (id) => rules.some((r) => r?.scope === scopeOf(id) && r.path === ''),
  };
}

/**
 * The words for what keeps a file or folder offline, for its mark and its
 * menu: the kept folder's `path` ('' for a whole drive, named `rootName`).
 */
export function keptWith(path, rootName) {
  if (path === null || path === undefined) return null;
  if (path === '') return `Kept offline with ${rootName ? `“${rootName}”` : 'the whole drive'}`;
  const name = path.slice(path.lastIndexOf('/') + 1);
  return `Kept offline with “${name}”`;
}

/** Whether two lists of kept folders say the same, so an unchanged one keeps its identity. */
export function samePinnedFolders(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((r, i) => r?.scope === b[i]?.scope && r?.path === b[i]?.path);
}

/** Whether two sets hold the same members. */
export function sameSet(a, b) {
  if (a === b) return true;
  if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
