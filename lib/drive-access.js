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

/*
 * A drive always has an owner: someone it belongs to, who can manage its
 * members. Admins reach every drive without a grant, which is how drives
 * came to have none — an admin who made one was never recorded as anything,
 * and removing or demoting a drive's last owner left nobody. So an admin can
 * hold an owner row (only an owner row: they reach every drive already, so
 * it grants them nothing), and:
 *
 *   an admin who makes a drive owns it;
 *   a change that takes a drive's last owner away — removing them, making
 *     them an editor or a viewer, removing the person altogether — makes
 *     the admin who made it the owner, in the same statement;
 *   a drive that has none anyway (from before this, or two owners removed
 *     at the same instant) is flagged on Admin → Overview, where one click
 *     makes the admin its owner.
 */

const email = (e) => String(e || '').trim().toLowerCase();

/**
 * Who becomes a drive's owner when a change would leave it with none: the
 * admin making the change. Never the person the change takes away — that
 * would only undo it — and never someone who is not an admin, whose change
 * is refused instead (null). Owners cannot change their own grant anyway,
 * so for them this is a backstop.
 */
export function ownerOfLastResort({ actor = {}, targetEmail } = {}) {
  const a = email(actor.email);
  return actor.isAdmin && a && a !== email(targetEmail) ? a : null;
}

/** Why a change that would leave a drive with no owner was refused, for the 409. */
export function lastOwnerRefusal({ actor = {}, targetEmail } = {}) {
  const t = email(targetEmail);
  return t === email(actor.email)
    ? 'You are this drive’s only owner. Make someone else an owner first.'
    : `${t} is this drive’s only owner. Make someone else an owner first.`;
}

/**
 * The drives' prefixes as LIKE patterns ('brand-assets/%'), with LIKE's own
 * characters escaped, for the listing query's drive clause.
 */
export function drivePatterns(drives = []) {
  const prefixes = [...new Set(drives.map((d) => clean(d?.prefix)).filter(Boolean))];
  return prefixes.map((p) => `${p.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`);
}

/**
 * How a prefix sits against the drives there are: `{ inside: d }` when it is
 * a drive's prefix or lies within one, `{ around: d }` when a drive lies
 * within it, null when it touches none.
 *
 * Buckets are not compared, on purpose. Which drive holds a file is decided
 * from its key alone (drivesHolding), so a drive in another bucket at the
 * same prefix still claims these keys — a new drive there would be inside
 * it all the same, as far as every access check is concerned.
 */
export function prefixOverlap(prefix, drives = []) {
  const p = clean(prefix);
  if (!p) return null;
  for (const d of drives) {
    const q = clean(d?.prefix);
    if (q && (p === q || p.startsWith(`${q}/`))) return { inside: d };
  }
  for (const d of drives) {
    const q = clean(d?.prefix);
    if (q && q.startsWith(`${p}/`)) return { around: d };
  }
  return null;
}
