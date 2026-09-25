/**
 * Drives as permission boundaries.
 *
 * A drive is a filespace: a prefix in the bucket with its own members, each a
 * viewer, an editor or an owner. The desktop app has always enforced that —
 * a viewer's mount is read-only, a non-member gets no mount — and this is the
 * same rule for the web, so a drive is private to its members wherever it is
 * opened from, like a disk only its people can plug in.
 *
 *   outside every drive   the library's own rules decide (visibility,
 *                         folder and file grants, who uploaded it)
 *   inside a drive        members may read (and then the library's rules
 *                         still apply, so a private file stays private);
 *                         editors and owners may change anything in it;
 *                         everyone else sees nothing — unless the file itself
 *                         was shared with them, which is a deliberate act
 *                         (file_acl) and is honoured
 *   admins                everything, as ever
 *
 * A drive inside another: membership of either one counts — belonging to the
 * outer drive reaches everything in it, as a disk reaches its folders.
 *
 * Pure: the queries live in lib/db.js and lib/file-query.js, this is the rule
 * they share, so it can be tested without a database.
 */

export const DRIVE_WRITE_ROLES = new Set(['editor', 'owner']);

const clean = (p) => String(p || '').replace(/^\/+|\/+$/g, '');

/** The drives whose place in the bucket holds this key (both, for a drive inside another). */
export function drivesHolding(key, drives = []) {
  const k = String(key || '');
  if (!k) return [];
  return drives.filter((d) => {
    const p = clean(d?.prefix);
    return p && k.startsWith(`${p}/`);
  });
}

/**
 * What someone's drive memberships allow for one stored object:
 * { inDrive, read, write }. `roles` maps a drive id to their role in it.
 */
export function driveAccess(key, { drives = [], roles = {}, isAdmin = false } = {}) {
  const holding = drivesHolding(key, drives);
  if (!holding.length) return { inDrive: false, read: true, write: true };
  if (isAdmin) return { inDrive: true, read: true, write: true };
  const mine = holding.map((d) => roles[d.id]).filter(Boolean);
  return { inDrive: true, read: mine.length > 0, write: mine.some((r) => DRIVE_WRITE_ROLES.has(r)) };
}

/** May this role add to, change or remove from a drive? */
export const canWriteDrive = (role, isAdmin = false) => isAdmin || DRIVE_WRITE_ROLES.has(role);

/**
 * The drives' prefixes as LIKE patterns ('brand-assets/%'), with LIKE's own
 * characters escaped, for the listing query's drive clause.
 */
export function drivePatterns(drives = []) {
  const prefixes = [...new Set(drives.map((d) => clean(d?.prefix)).filter(Boolean))];
  return prefixes.map((p) => `${p.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`);
}
