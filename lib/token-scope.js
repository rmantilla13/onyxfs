// lib/token-scope.js — read-only device tokens scoped to chosen drives.
//
// An OAuth client that asks for `onyx.read` (lib/oauth.js) gets a token that
// reads files in the drives the person picked on the consent page, and
// nothing else: Rollout, which catalogs and publishes photos that stay in
// Onyx, is the first. Every other token — Onyx for Mac's, the iPhone's,
// Claude's — has no scope recorded and keeps everything it had.
//
// Three fences, each enough on its own for what it covers:
//
//   1. The route list below. A read token reaches only these, and only with
//      these methods; anything else is a 403 before a handler runs
//      (lib/desktop-guard.js). No web session, no MCP, no STS, no writes.
//   2. The principal (narrowPrincipal). Built from the person's own, then cut
//      to a viewer of the token's drives: never an admin, no library, no
//      folder grants, no capability that changes anything. A route the list
//      lets through decides from this, as it always does.
//   3. The drive check (withinTokenDrives). A file someone may see can lie
//      outside every drive — a library file marked visible to the org — and
//      canAccessFile says yes to it. The routes that hand out one file's URL
//      ask this too.
//
// Pure and dependency-free apart from the role and drive helpers, so the
// whole rule is testable without a database.

import { READ_ONLY_ROLE, roleCaps } from './roles.js';
import { drivePatterns, drivesHolding } from './drive-access.js';
import { READ_SCOPE } from './oauth.js';

export { READ_SCOPE };

/** Is this token row (or its scope) a read-only, drive-scoped one? */
export const isReadScope = (scope) => scope === READ_SCOPE;

// What a read token may ask for. Each a method set and an anchored path.
const READ_ROUTES = Object.freeze([
  { methods: ['GET', 'HEAD'], path: /^\/api\/files\/delta$/ }, // a drive's files and what changed
  { methods: ['GET', 'HEAD'], path: /^\/api\/space\/files\/[^/]+$/ }, // one file's URLs, freshly signed
  { methods: ['GET', 'HEAD'], path: /^\/api\/space\/filespaces$/ }, // the drives it was given
  { methods: ['GET', 'HEAD'], path: /^\/api\/desktop\/me$/ }, // is the token still good
  { methods: ['DELETE'], path: /^\/api\/desktop\/me$/ }, // sign itself out
]);

/** May a read token make this request? */
export function readTokenAllows(method, pathname) {
  const m = String(method || '').toUpperCase();
  const p = String(pathname || '').replace(/\/+$/, '') || '/';
  return READ_ROUTES.some((r) => r.methods.includes(m) && r.path.test(p));
}

export const READ_TOKEN_REFUSAL = 'This connection can only read files in the drives it was given.';

/**
 * The drive ids a consent may grant: the ones asked for that this person can
 * open, de-duplicated, in the order asked. `canOpen(id)` is their principal's
 * answer (lib/authz.js driveRoleOf).
 */
export function grantableDrives(requested, canOpen) {
  const ids = Array.isArray(requested) ? requested : [];
  const out = [];
  for (const raw of ids) {
    const id = String(raw || '').trim();
    if (id && !out.includes(id) && canOpen(id)) out.push(id);
  }
  return out;
}

/** Read the stored drive list (a JSON array in a TEXT column) back. */
export function parseDriveIds(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (!value) return [];
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * The principal a read token acts as: `base` (getPrincipal's, for the person
 * behind the token) cut down to a viewer of `driveIds`.
 *
 * `drives` is every drive there is (loadDriveGrants' list). It stays whole in
 * the drive scope on purpose: which drive holds a file is decided from its
 * key against every drive (lib/drive-access.js), so a file in a drive this
 * token was not given still resolves to that drive, and is refused there,
 * rather than looking like a file in no drive at all.
 *
 * A drive the person cannot open any more is dropped, so a token never
 * outlives the access it was granted from: removing someone from a drive
 * removes it from their token at the next request.
 */
export function narrowPrincipal(base, { driveIds = [], drives = [] } = {}) {
  const reach = (id) => !!base?.isAdmin || !!base?.driveScope?.roles?.[id];
  const kept = drives.filter((d) => driveIds.includes(d.id) && reach(d.id));
  const readCaps = roleCaps(READ_ONLY_ROLE);
  const caps = new Set([...readCaps].filter((c) => base?.isAdmin || (base?.caps instanceof Set && base.caps.has(c))));
  const roles = Object.fromEntries(kept.map((d) => [d.id, 'viewer']));
  return {
    ...base,
    isAdmin: false,
    isSuperAdmin: false,
    legacyAdmin: false,
    // Role-subject grants (folder_access, file_acl) match on this: none for a
    // token, so nothing granted to the person's role reaches past its drives.
    roleId: null,
    caps,
    flags: { ...(base?.flags || {}), library: false, shares: false, aiGenerate: false },
    folderGrants: [],
    driveScope: { drives, roles, isAdmin: false },
    drivePatterns: { all: drivePatterns(drives), mine: drivePatterns(kept), write: [] },
    tokenScope: { scope: READ_SCOPE, driveIds: kept.map((d) => d.id) },
  };
}

/** Does this principal come from a read token? */
export const readScoped = (principal) => isReadScope(principal?.tokenScope?.scope);

/**
 * Is this stored object inside one of the token's drives? Always true for a
 * principal that is not read-scoped.
 */
export function withinTokenDrives(principal, storageKey) {
  if (!readScoped(principal)) return true;
  const ids = new Set(principal.tokenScope.driveIds || []);
  return drivesHolding(storageKey, principal.driveScope?.drives || []).some((d) => ids.has(d.id));
}

/** Is this drive one the token was given? Always true for a principal that is not read-scoped. */
export function tokenHasDrive(principal, driveId) {
  if (!readScoped(principal)) return true;
  return (principal.tokenScope.driveIds || []).includes(String(driveId || ''));
}
