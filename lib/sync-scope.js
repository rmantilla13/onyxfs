/**
 * The part of a sync feed that is about who is asking rather than what
 * changed. Server-only (node:crypto), otherwise pure.
 *
 * A device syncs by cursor: it asks what changed since the last `seq` it
 * applied. That catches every change to a file, but not every change to who
 * may see one. Joining or leaving a drive, a folder grant, a new drive carved
 * out of the library — none of them writes a file row, so none of them moves
 * a cursor, and a device would go on showing what it was shown before.
 *
 * So each page carries a fingerprint of the access it was computed under.
 * When it differs from the one a device last saw, the device starts again
 * from cursor 0 and replaces what it holds. (A grant or revoke on a single
 * file does write the row — setFileAcl — so that one arrives as a change.)
 */
import { createHash } from 'node:crypto';
import { drivePatterns } from './drive-access.js';

/**
 * A short digest of everything that decides what `principal` may see: who
 * they are (the owner rule and direct grants are per person, so two people
 * with identical memberships still see different files), admin or not, role,
 * folder grants, drive memberships and roles, and where every drive is
 * (`allPatterns`), since a new drive takes its files out of the library.
 * Stable across calls for the same access; any change moves it.
 */
export function accessFingerprint(principal = {}, allPatterns = []) {
  const roles = principal.isAdmin ? {} : (principal.driveScope?.roles || {});
  const body = JSON.stringify({
    who: String(principal.email || '').toLowerCase(),
    admin: !!principal.isAdmin,
    role: principal.roleId || null,
    grants: [...(principal.folderGrants || [])].map(String).sort(),
    drives: Object.entries(roles).filter(([, r]) => r).map(([id, r]) => `${id}:${r}`).sort(),
    where: [...allPatterns].map(String).sort(),
  });
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

/**
 * A digest of the folder list a page carries (`folders=1`): the scope's
 * folders as this caller may see them, already narrowed to their grants.
 *
 * A mounted drive asks for its folders on every pass, every few seconds, and
 * a drive's list is the same from one pass to the next almost always. So the
 * feed hands this back with the list, the device sends it again with its next
 * request (`foldersTag`), and while it still matches the list is left out:
 * the device keeps the one it has. A device that sends none — every one from
 * before this — gets the list every time, as it always did.
 *
 * Of the names as a set, so the order they are read in does not move it.
 * Anything added, removed or renamed does.
 */
export function foldersTag(folders = []) {
  const body = JSON.stringify([...folders].map(String).sort());
  return createHash('sha256').update(body).digest('hex').slice(0, 32);
}

/**
 * The feed's scope for `?drive=`: one drive, the library (files in no
 * drive), or everything. `drive` is the filespace the caller may open
 * (resolved and authorized by the route), `allDrives` every drive there is.
 */
export function syncScope({ drive, library = false, allDrives = [] }) {
  if (drive) {
    const [pattern] = drivePatterns([drive]);
    return pattern ? { drivePattern: pattern } : null;
  }
  if (library) return { libraryPatterns: drivePatterns(allDrives) };
  return {};
}
