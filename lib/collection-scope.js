// lib/collection-scope.js — a collection, as the listing reads it.
//
// The server half of lib/collections.js: who may see a collection, who may
// change it, and the listing options that list its files. Kept apart from
// the pure module because it reads the database.

import { getCollection, listFilespaces, listFilespacesForSpace } from './db.js';
import { can, libraryOpen } from './authz.js';
import { canWriteDrive, drivePatterns } from './drive-access.js';
import { collectionVisible, normalizeCollection } from './collections.js';

/**
 * Whether `principal` may make, change or delete collections in a drive
 * (`drive` from listFilespacesForSpace, with its role) or in All Files
 * (`drive` null): whoever may edit files there — tags and metadata are what
 * collections are made of.
 */
export function canEditCollections(principal, drive) {
  if (!can(principal, 'files.edit').ok) return false;
  return drive ? canWriteDrive(drive.role, principal.isAdmin) : libraryOpen(principal);
}

/**
 * A collection made in All files while there is none (the `library` flag
 * off): its rules ask of a place that is not there, so nobody opens it. It
 * is not hidden from whoever could change it when there was one — files.edit
 * — or it would look deleted (and be made again): they are shown it, to move
 * into a drive (PATCH /api/collections/[id] { driveId }) or delete.
 */
// Not while the flags are unread (`degraded`): their defaults have no All
// files, and a live one taken for gone would be offered to move out of it.
export const isStranded = (collection, principal) => !collection?.driveId && !principal?.degraded && !libraryOpen(principal);
const mayTidyStranded = (principal) => can(principal, 'files.edit').ok;

/**
 * A collection as its viewer sees it: the stored one, `canEdit` for this
 * principal, or null when it is not there or its drive is not one they can
 * open — the same answer for both, so which collections exist in a drive is
 * not theirs to find out. With `stranded`, one made in All files while there
 * is none comes back too, marked so, for whoever may move or delete it.
 */
export async function collectionFor(id, principal, drives = null, { stranded = false } = {}) {
  const c = await getCollection(id);
  if (!c) return null;
  const mine = drives || (await listFilespacesForSpace(principal.email, principal));
  if (!collectionVisible(c, mine, { library: libraryOpen(principal) })) {
    if (stranded && isStranded(c, principal) && mayTidyStranded(principal)) return { ...c, stranded: true, canEdit: true, drive: null };
    return null;
  }
  const drive = c.driveId ? mine.find((d) => d.id === c.driveId) : null;
  return { ...c, canEdit: canEditCollections(principal, drive), drive };
}

/** A collection as a client is sent it (GET /api/collections, the files page). */
export function collectionForClient(c, principal, drives) {
  const drive = c.driveId ? drives.find((d) => d.id === c.driveId) : null;
  const stranded = isStranded(c, principal);
  return {
    id: c.id, driveId: c.driveId, name: c.name, match: c.match, rules: c.rules, updatedAt: c.updatedAt,
    canEdit: stranded ? mayTidyStranded(principal) : canEditCollections(principal, drive),
    ...(stranded ? { stranded: true } : {}),
  };
}

/**
 * The collections `principal` is sent, by drive then name: those of the
 * drives they can open, and of All files while there is one. `stranded` adds
 * the ones made in All files while there is none, for whoever may tidy them
 * — the web asks for them; the iPhone and the Mac, which cannot, do not.
 */
export function visibleCollections(all, principal, drives, { stranded = false } = {}) {
  const library = libraryOpen(principal);
  const tidy = stranded && !library && mayTidyStranded(principal);
  return all
    .filter((c) => collectionVisible(c, drives, { library }) || (tidy && !c.driveId))
    .map((c) => collectionForClient(c, principal, drives));
}

/**
 * The listing options for a collection's files: its rules (normalized), the
 * drive it is in as the storage prefix (undefined for All Files: everything
 * its viewer may open), and every drive's prefix, which tells the query
 * which scope's folder rows a file inherits from.
 */
export async function collectionListing(collection) {
  const all = await listFilespaces();
  const { match, rules } = normalizeCollection(collection);
  const drive = collection.drive || (collection.driveId ? all.find((d) => d.id === collection.driveId) : null);
  return {
    storagePrefix: drive ? String(drive.prefix || '').replace(/^\/+|\/+$/g, '') : undefined,
    collection: { match, rules, drivePatterns: drivePatterns(all) },
  };
}
