// lib/people.js — the shared half of the People and Invites admin APIs.
// Server-only. The routes stay thin: they authorize, call these, and write
// an audit row.

import {
  getSetting, setSetting, getFilespaceById, grantFilespaceAccess, revokeFilespaceAccess, isFilespaceRole,
  backfillPeople,
} from './db.js';
import { getAdminEmails, isAdmin } from './auth-allowlist.js';
import { parseRolesConfig, resolveRole, ADMIN_ROLE } from './roles.js';
import { parsePolicy, effectiveLimits } from './policy.js';

/**
 * The role config and policy for a WRITE: fresh and strict, so a save made
 * on the strength of a failed read cannot quietly apply defaults. Throws;
 * the route answers 503.
 */
export async function loadRolesAndPolicy({ fresh = true } = {}) {
  const [roles, policy] = [
    await getSetting('roles.config', { fresh, strict: true }),
    await getSetting('policy.limits', { fresh, strict: true }),
  ];
  return { rawRoles: roles, rolesConfig: parseRolesConfig(roles), policy: parsePolicy(policy) };
}

const BACKFILL_KEY = 'people.backfill';
let backfilled = false;

/**
 * The one-time seed (backfillPeople): everyone who has signed in, every
 * approved invite and every admin gets a people row, and v1's role
 * assignments are copied onto them. Recorded in settings once done, so an
 * admin who later sets someone back to the default role does not have the
 * old assignment copied over them again. Run by the People list, and before
 * any role change — a change made before the list had ever loaded would
 * otherwise be overwritten by the seed when it did.
 */
export async function backfillOnce(rawRoles) {
  if (backfilled) return;
  if (await getSetting(BACKFILL_KEY, { fresh: true, strict: true })) { backfilled = true; return; }
  const assignments = rawRoles && typeof rawRoles === 'object' && rawRoles.assignments && typeof rawRoles.assignments === 'object'
    ? rawRoles.assignments : {};
  const result = await backfillPeople({ adminEmails: getAdminEmails(), assignments });
  await setSetting(BACKFILL_KEY, { at: Date.now(), ...result }, 'system');
  backfilled = true;
}

/** A role id an admin may assign: one that exists, and not the implicit Admin. */
export function assignableRole(rolesConfig, roleId) {
  if (roleId === ADMIN_ROLE.id) return null;
  return rolesConfig.roles.find((r) => r.id === roleId) || null;
}

/** "a@x.com, b@y.com\nc@z.com" or ['a@x.com'] → unique lowercased addresses, and the ones that are not. */
export function parseEmails(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[\s,;]+/);
  const good = [];
  const bad = [];
  for (const item of raw) {
    const e = String(item || '').trim().toLowerCase();
    if (!e) continue;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { if (!good.includes(e)) good.push(e); } else bad.push(e);
  }
  return { emails: good, invalid: bad };
}

/** [{ filespaceId, role }] → validated grants, or { error }. */
export async function parseGrants(grants) {
  if (grants == null) return { grants: [] };
  if (!Array.isArray(grants)) return { error: 'grants must be a list of { filespaceId, role }.' };
  const out = [];
  for (const g of grants) {
    const id = String(g?.filespaceId || '').trim();
    const role = String(g?.role || 'viewer');
    if (!id) return { error: 'Each grant needs a filespaceId.' };
    if (!isFilespaceRole(role)) return { error: `"${role}" is not a drive role (viewer, editor or owner).` };
    const fs = await getFilespaceById(id);
    if (!fs) return { error: `No drive with id ${id}.` };
    if (!out.some((x) => x.filespaceId === id)) out.push({ filespaceId: id, role, name: fs.name });
  }
  return { grants: out };
}

/**
 * Make `wanted` the person's drive grants, as a diff against `current`
 * ([{ filespaceId, role }]): grant or change what differs, revoke what is
 * gone. Returns what changed, for the audit row.
 */
export async function applyGrantDiff(email, current, wanted, by) {
  const now = new Map(current.map((g) => [g.filespaceId, g.role]));
  const next = new Map(wanted.map((g) => [g.filespaceId, g.role]));
  const granted = [];
  const revoked = [];
  for (const [id, role] of next) {
    if (now.get(id) !== role) {
      await grantFilespaceAccess({ filespaceId: id, email, role, grantedBy: by });
      granted.push({ filespaceId: id, role });
    }
  }
  for (const id of now.keys()) {
    if (!next.has(id)) {
      await revokeFilespaceAccess({ filespaceId: id, email });
      revoked.push(id);
    }
  }
  return { granted, revoked };
}

/** The name to show: their own, then the one they asked with, then Okta's, then the address. */
export function displayNameFor({ email, person, inviteName, userName }) {
  return person?.displayName || inviteName || userName || String(email || '').split('@')[0] || email;
}

/**
 * What the People list and drawer say about someone. `row` is a listPeople
 * row (or personDetail's head); `ctx` the role config and policy.
 *
 *   status  'active' | 'invited' (approved, never signed in) | 'suspended'
 *   role    Admin for an env admin, whatever is set on their row otherwise
 *   legacyAdmin  held the retired full-access role and is not in
 *                ADMIN_EMAILS: now a Member, and the People page says so
 */
export function presentPerson(row, { rolesConfig, policy, adminEmails = getAdminEmails() }) {
  const person = row.person;
  const email = person?.email || row.email;
  const envAdmin = adminEmails.includes(email);
  const role = resolveRole(email, rolesConfig, { isAdmin: envAdmin, roleId: person?.roleId || null, hasRow: !!person });
  const limits = effectiveLimits({ role, person, policy, isAdmin: envAdmin });
  const signedIn = !!(row.hasUser || person?.firstSeenAt);
  const status = person?.status === 'suspended' ? 'suspended' : signedIn ? 'active' : 'invited';
  const lastActiveAt = Math.max(Number(person?.lastSeenAt) || 0, Number(row.deviceLastUsedAt) || 0) || null;
  return {
    id: person?.id || null,
    email,
    name: displayNameFor({ email, person, inviteName: row.inviteName, userName: row.userName }),
    role: { id: role.id, name: role.name },
    roleId: person?.roleId || null,
    isAdmin: envAdmin,
    adminSource: envAdmin ? 'ADMIN_EMAILS' : null,
    legacyAdmin: !envAdmin && !!role.legacyAdmin,
    status,
    statusReason: person?.statusReason || null,
    statusChangedAt: person?.statusChangedAt || null,
    statusChangedBy: person?.statusChangedBy || null,
    pauseLinks: person?.pauseLinks !== false,
    drives: row.drives ?? null,
    devices: row.devices ?? null,
    storage: { bytes: row.bytes ?? null, quotaBytes: limits.storageQuotaBytes },
    lastActiveAt,
    firstSeenAt: person?.firstSeenAt || null,
    approvedBy: row.reviewedBy || null,
    approvedAt: row.reviewedAt || null,
    limits: {
      overrides: {
        quotaBytes: person?.quotaBytes ?? null,
        maxUploadBytes: person?.maxUploadBytes ?? null,
        aiMonthlyCents: person?.aiMonthlyCents ?? null,
      },
      role: {
        storageQuotaBytes: role.limits?.storageQuotaBytes ?? null,
        maxUploadBytes: role.limits?.maxUploadBytes ?? null,
        aiMonthlyCents: role.limits?.aiMonthlyCents ?? null,
      },
      effective: limits,
    },
  };
}

/**
 * Why an admin may not do something to this person, or null. Env admins are
 * managed in ADMIN_EMAILS — their role, suspension and removal are not the
 * panel's to change — and nobody suspends or removes themselves.
 */
export function personActionProblem({ actor, target, action }) {
  const t = String(target || '').toLowerCase();
  if (['role', 'suspend', 'remove'].includes(action) && isAdmin(t)) {
    return { status: 400, error: 'Managed in ADMIN_EMAILS.' };
  }
  if (['suspend', 'remove'].includes(action) && t === String(actor || '').toLowerCase()) {
    return { status: 400, error: action === 'suspend' ? 'You can’t suspend yourself.' : 'You can’t remove yourself.' };
  }
  return null;
}
