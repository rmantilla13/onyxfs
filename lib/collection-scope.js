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
 * A collection as its viewer sees it: the stored one, `canEdit` for this
 * principal, or null when it is not there or its drive is not one they can
 * open — the same answer for both, so which collections exist in a drive is
 * not theirs to find out.
 */
export async function collectionFor(id, principal, drives = null) {
  const c = await getCollection(id);
  if (!c) return null;
  const mine = drives || (await listFilespacesForSpace(principal.email, principal));
  if (!collectionVisible(c, mine, { library: libraryOpen(principal) })) return null;
  const drive = c.driveId ? mine.find((d) => d.id === c.driveId) : null;
  return { ...c, canEdit: canEditCollections(principal, drive), drive };
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
