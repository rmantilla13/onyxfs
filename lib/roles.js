// lib/roles.js — platform roles: what kinds of things someone may do anywhere.
//
// Three axes decide whether a person may do something, and each can only take
// permission away (proposal §1.1):
//
//   admission      may this email sign in now?  (lib/auth-allowlist.js)
//   platform role  what kinds of things, anywhere?  (this file)
//   drive role     which storage, and how?  (filespace_access, lib/drive-access.js)
//
// A role is a set of CAPABILITIES plus LIMITS. A capability absent from a
// role's `caps` is allowed; `false` takes it away. Limits are numbers where
// null means "no limit", and each person's effective limit is the smallest
// of the org ceiling (lib/policy.js), their own override and their role's
// value — so a role, or an override, can lower what the org allows and
// never raise it.
//
// ADMIN IS NOT A ROLE HERE. Admins are exactly the addresses in ADMIN_EMAILS,
// on purpose: a misconfigured role must never be able to lock every admin out
// of the panel that would let them fix it, nor make someone an admin. The old
// assignable "Admin" role carried `full: true`, which made its holders owner
// of every drive in the desktop app — and only there. `full` now grants
// nothing anywhere; people who held it resolve to Member and are flagged
// (`legacyAdmin`) so the People page can say so.
//
// Stored as one settings blob under 'roles.config':
//
//   { version: 2,
//     defaultRole: 'member',
//     roles: [{ id, name, description, builtin,
//               caps:   { 'shares.public': false, ... },     // absent = allowed
//               limits: { storageQuotaBytes, maxUploadBytes, aiMonthlyCents,
//                         shareMaxExpiryDays, driveCeiling } }],
//     assignments: { ... },    // v1's email → role map; read, never written
//     legacyFullIds: [...] }   // ids of retired full-access roles, see below
//
// Version 1 blobs (no `version`) are still read: their copies of the built-in
// roles were snapshots of the old defaults and are replaced by the ones
// below; a custom role keeps its name and has its old `features` map
// translated into capabilities.
//
// Who holds which role lives in `people.role_id` (NULL = the default role).
// v1's `assignments` is consulted only for someone with no people row yet.

// ── Capabilities ────────────────────────────────────────────────────────────
// `drive: true` means the action also needs editor or owner on the drive in
// question (or creator rights outside drives) — the capability is necessary,
// never sufficient.
export const CAPABILITIES = [
  { id: 'files.upload', label: 'Upload files and new versions', drive: true },
  { id: 'files.edit', label: 'Rename, move, tag and edit metadata', drive: true },
  { id: 'files.delete', label: 'Move files to the trash', drive: true },
  { id: 'folders.manage', label: 'Create, rename, move and delete folders', drive: true },
  { id: 'shares.private', label: 'Make private (sign-in) links' },
  { id: 'shares.public', label: 'Make public and password links' },
  { id: 'review.links', label: 'Make external review links' },
  { id: 'review.comment', label: 'Comment, reply and resolve their own comments' },
  { id: 'review.decide', label: 'Approve or request changes' },
  { id: 'ai.generate', label: 'Generate and fix with AI, within budget' },
  { id: 'drives.create', label: 'Create drives, when the org allows self-serve' },
  { id: 'desktop.mount', label: 'Mount drives in the desktop app' },
];
export const CAPABILITY_IDS = CAPABILITIES.map((c) => c.id);
const CAP_SET = new Set(CAPABILITY_IDS);
export const isCapability = (id) => CAP_SET.has(id);

// ── Limits ──────────────────────────────────────────────────────────────────
// Numbers, null = no limit. driveCeiling is the highest drive role honoured:
// a Viewer granted "editor" on a drive is an editor nowhere, on the web, the
// desktop or in the credentials STS mints.
export const NUMERIC_LIMITS = ['storageQuotaBytes', 'maxUploadBytes', 'aiMonthlyCents', 'shareMaxExpiryDays'];
export const DRIVE_ROLES = ['viewer', 'editor', 'owner'];
const DRIVE_RANK = { viewer: 1, editor: 2, owner: 3 };

/** The lower of two drive roles; a missing one is no role at all. */
export function capDriveRole(granted, ceiling = 'owner') {
  if (!DRIVE_RANK[granted]) return null;
  const c = DRIVE_RANK[ceiling] ? ceiling : 'owner';
  return DRIVE_RANK[granted] <= DRIVE_RANK[c] ? granted : c;
}

const OPEN_LIMITS = {
  storageQuotaBytes: null,
  maxUploadBytes: null,
  // Every AI budget starts at $0 — AI is off until the owner sets one.
  aiMonthlyCents: 0,
  shareMaxExpiryDays: null,
  driveCeiling: 'owner',
};

const denyAll = (ids) => Object.fromEntries(ids.map((id) => [id, false]));

export const BUILTIN_ROLES = [
  {
    id: 'member',
    name: 'Member',
    description: 'The default. The working team: upload, organise and share what their drives allow.',
    builtin: true,
    caps: {},
    limits: { ...OPEN_LIMITS },
  },
  {
    id: 'contributor',
    name: 'Contributor',
    description:
      'Adds and organises work, but cannot hand it outside the org: no public, password or review links, and no drive creation.',
    builtin: true,
    caps: denyAll(['shares.public', 'review.links', 'drives.create']),
    limits: { ...OPEN_LIMITS, shareMaxExpiryDays: 30 },
  },
  {
    id: 'viewer',
    name: 'Viewer',
    description:
      'Reads, downloads, comments and approves, but changes nothing. Read-only in the desktop app.',
    builtin: true,
    caps: denyAll([
      'files.upload', 'files.edit', 'files.delete', 'folders.manage',
      'shares.private', 'shares.public', 'review.links', 'ai.generate', 'drives.create',
    ]),
    limits: { ...OPEN_LIMITS, storageQuotaBytes: 0, maxUploadBytes: 0, driveCeiling: 'viewer' },
  },
];
const BUILTIN_IDS = new Set(BUILTIN_ROLES.map((r) => r.id));

/**
 * The implicit role of an env admin. Never stored, never assignable, and not
 * in any list an admin picks from: it is what isAdmin() means, expressed in
 * the same shape as the others so one code path reads both.
 */
export const ADMIN_ROLE = {
  id: 'admin',
  name: 'Admin',
  description: 'Set in ADMIN_EMAILS. Owner of every drive, and the admin panel.',
  builtin: true,
  implicit: true,
  caps: {},
  limits: { storageQuotaBytes: null, maxUploadBytes: null, aiMonthlyCents: null, shareMaxExpiryDays: null, driveCeiling: 'owner' },
};

export const DEFAULT_ROLES_CONFIG = {
  version: 2,
  defaultRole: 'member',
  roles: BUILTIN_ROLES,
  assignments: {},
};

const clone = (o) => JSON.parse(JSON.stringify(o));

// ── Reading a stored config ─────────────────────────────────────────────────

/** Only known capabilities, and only `false` — absent already means allowed. */
function normalizeCaps(caps) {
  const out = {};
  if (caps && typeof caps === 'object' && !Array.isArray(caps)) {
    for (const id of CAPABILITY_IDS) if (caps[id] === false) out[id] = false;
  }
  return out;
}

const isLimitNumber = (v) => v === null || (Number.isInteger(v) && v >= 0);

/** Known limits over `base`, each kept only when it is a valid value. */
function normalizeLimits(limits, base = OPEN_LIMITS) {
  const out = { ...base };
  if (limits && typeof limits === 'object' && !Array.isArray(limits)) {
    for (const k of NUMERIC_LIMITS) if (k in limits && isLimitNumber(limits[k])) out[k] = limits[k];
    if (DRIVE_ROLES.includes(limits.driveCeiling)) out.driveCeiling = limits.driveCeiling;
  }
  return out;
}

/**
 * v1 `features` → v2 caps. Only the id `viewer` was ever checked by a route,
 * so a custom role kept every file capability whatever its map said, and it
 * keeps them now. `shares: false` did stop every kind of link (the share
 * route read the flag for all of them), so it still does.
 */
function capsFromFeatures(features) {
  if (features && features.shares === false) return denyAll(['shares.private', 'shares.public', 'review.links']);
  return {};
}

function normalizeRole(r, { v1 }) {
  const builtin = BUILTIN_ROLES.find((b) => b.id === r.id);
  // A v1 copy of a built-in is the old default, saved; the new default wins.
  if (builtin && v1) return clone(builtin);
  const base = builtin ? builtin.limits : OPEN_LIMITS;
  return {
    id: String(r.id),
    name: String(r.name || builtin?.name || r.id).slice(0, 60),
    description: String(r.description || builtin?.description || '').slice(0, 300),
    builtin: !!builtin,
    caps: v1 && !builtin ? capsFromFeatures(r.features) : normalizeCaps(r.caps),
    limits: normalizeLimits(v1 && !builtin ? null : r.limits, base),
  };
}

/**
 * Any stored roles.config, v1 or v2, well-formed or not → a v2 config.
 * `legacyFullIds` lists the roles that were `full: true` (the old Admin);
 * they are not roles any more, and resolveRole turns them into Member.
 */
export function parseRolesConfig(saved) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
    return { ...clone(DEFAULT_ROLES_CONFIG), legacyFullIds: [] };
  }
  const v1 = saved.version !== 2;
  const roles = [];
  const legacyFullIds = [];
  const seen = new Set();
  for (const r of Array.isArray(saved.roles) ? saved.roles : []) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (r.full || r.id === ADMIN_ROLE.id) { legacyFullIds.push(r.id); continue; }
    roles.push(normalizeRole(r, { v1 }));
  }
  // Fold in any built-in the saved config predates, so a deploy that adds one
  // picks it up without clobbering custom roles.
  for (const b of BUILTIN_ROLES) if (!seen.has(b.id)) roles.push(clone(b));
  // Built-ins first, in their own order, then custom roles as saved.
  roles.sort((a, b) => (BUILTIN_IDS.has(b.id) - BUILTIN_IDS.has(a.id))
    || (BUILTIN_ROLES.findIndex((x) => x.id === a.id) - BUILTIN_ROLES.findIndex((x) => x.id === b.id)));

  const assignments = {};
  if (saved.assignments && typeof saved.assignments === 'object') {
    for (const [email, id] of Object.entries(saved.assignments)) {
      if (typeof id === 'string') assignments[String(email).trim().toLowerCase()] = id;
    }
  }
  // A v2 save carries the ids forward, so someone still pointing at a retired
  // full role keeps being flagged after the role itself is gone.
  if (!v1 && Array.isArray(saved.legacyFullIds)) {
    for (const id of saved.legacyFullIds) if (typeof id === 'string' && !legacyFullIds.includes(id)) legacyFullIds.push(id);
  }
  const wanted = typeof saved.defaultRole === 'string' ? saved.defaultRole : 'member';
  const defaultRole = roles.some((r) => r.id === wanted) ? wanted : 'member';
  return { version: 2, defaultRole, roles, assignments, legacyFullIds };
}

// ── Resolving someone's role ────────────────────────────────────────────────

/**
 * The role for an email. Order: the person's own row (`roleId`), then v1's
 * assignments map, then the default. Env admins get ADMIN_ROLE.
 *
 * Returns a role object with `legacyAdmin: true` when what was stored for
 * them was the retired full-access role — they resolve to Member, which
 * takes nothing away, and lose only the desktop-only "owner of every drive".
 */
export function resolveRole(email, config, { isAdmin = false, roleId = null } = {}) {
  if (isAdmin) return { ...clone(ADMIN_ROLE), legacyAdmin: false };
  const cfg = config && config.version === 2 && Array.isArray(config.legacyFullIds) ? config : parseRolesConfig(config);
  const e = String(email || '').trim().toLowerCase();
  let id = roleId || cfg.assignments[e] || cfg.defaultRole;
  let legacyAdmin = false;
  if (cfg.legacyFullIds.includes(id) || id === ADMIN_ROLE.id) {
    legacyAdmin = true;
    id = 'member';
  }
  const role = cfg.roles.find((r) => r.id === id)
    || cfg.roles.find((r) => r.id === cfg.defaultRole)
    || cfg.roles.find((r) => r.id === 'member')
    || BUILTIN_ROLES[0];
  return { ...clone(role), legacyAdmin };
}

/** The capabilities a role grants, as a Set. The implicit admin role has all of them. */
export function roleCaps(role) {
  if (!role) return new Set();
  if (role.implicit && role.id === ADMIN_ROLE.id) return new Set(CAPABILITY_IDS);
  return new Set(CAPABILITY_IDS.filter((id) => role.caps?.[id] !== false));
}

/**
 * Whether a principal holds a capability. A principal from getPrincipal
 * carries `caps`; one built by hand (tests, a few server-side callers) is
 * read through its built-in role id, and an unknown id holds nothing — the
 * absence of an answer is a no.
 */
export function principalHasCap(principal, cap) {
  if (!principal) return false;
  if (principal.isAdmin) return true;
  if (principal.caps instanceof Set) return principal.caps.has(cap);
  const builtin = BUILTIN_ROLES.find((r) => r.id === principal.roleId);
  return builtin ? roleCaps(builtin).has(cap) : false;
}

// ── Saving a config (PUT /api/admin/roles) ──────────────────────────────────

const ROLE_ID = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * An admin's roles config → { config, removed } | { error }.
 *
 * Strict, where parseRolesConfig is forgiving: a save that silently dropped
 * half of what was sent would look like it worked. `full` is refused
 * outright — it grants nothing now, and accepting it would suggest it does.
 * Built-in roles can be edited and not deleted; `assignments` are carried
 * over from what is stored and never taken from the request.
 * `removed` lists custom roles the save deletes, whose people move to the
 * default role.
 */
export function validateRolesConfig(input, current) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Send { roles, defaultRole }.' };
  if (!Array.isArray(input.roles) || !input.roles.length) return { error: 'roles must be a non-empty list.' };
  const stored = parseRolesConfig(current);
  const roles = [];
  const seen = new Set();
  for (const r of input.roles) {
    if (!r || typeof r !== 'object') return { error: 'Each role must be an object.' };
    const id = String(r.id || '');
    if (id === ADMIN_ROLE.id) return { error: 'Admin is not a role: admins are the addresses in ADMIN_EMAILS.' };
    if (!ROLE_ID.test(id)) return { error: `"${id}" is not a valid role id (lowercase letters, digits and dashes, 2–32 characters).` };
    if (seen.has(id)) return { error: `The role "${id}" appears twice.` };
    seen.add(id);
    if ('full' in r && r.full) return { error: `"${id}": full access is no longer a role setting. Add real admins to ADMIN_EMAILS.` };
    const name = String(r.name ?? '').trim();
    if (!name || name.length > 60) return { error: `"${id}": give it a name of up to 60 characters.` };
    const description = String(r.description ?? '').trim();
    if (description.length > 300) return { error: `"${id}": keep the description under 300 characters.` };

    const caps = {};
    if (r.caps != null) {
      if (typeof r.caps !== 'object' || Array.isArray(r.caps)) return { error: `"${id}": caps must be an object.` };
      for (const [k, v] of Object.entries(r.caps)) {
        if (!isCapability(k)) return { error: `"${id}": unknown capability "${k}".` };
        if (typeof v !== 'boolean') return { error: `"${id}": ${k} must be true or false.` };
        if (v === false) caps[k] = false;
      }
    }
    const builtin = BUILTIN_ROLES.find((b) => b.id === id);
    const limits = { ...(builtin ? builtin.limits : OPEN_LIMITS) };
    if (r.limits != null) {
      if (typeof r.limits !== 'object' || Array.isArray(r.limits)) return { error: `"${id}": limits must be an object.` };
      for (const [k, v] of Object.entries(r.limits)) {
        if (k === 'driveCeiling') {
          if (!DRIVE_ROLES.includes(v)) return { error: `"${id}": driveCeiling must be viewer, editor or owner.` };
          limits.driveCeiling = v;
        } else if (NUMERIC_LIMITS.includes(k)) {
          if (!isLimitNumber(v)) return { error: `"${id}": ${k} must be a whole number of 0 or more, or null for no limit.` };
          limits[k] = v;
        } else {
          return { error: `"${id}": unknown limit "${k}".` };
        }
      }
    }
    roles.push({ id, name, description, builtin: !!builtin, caps, limits });
  }
  for (const b of BUILTIN_ROLES) {
    if (!seen.has(b.id)) return { error: `The built-in role "${b.name}" cannot be deleted.` };
  }
  const defaultRole = input.defaultRole == null ? stored.defaultRole : String(input.defaultRole);
  if (!roles.some((r) => r.id === defaultRole)) return { error: `The default role "${defaultRole}" is not in the list.` };

  const removed = stored.roles.filter((r) => !r.builtin && !seen.has(r.id)).map((r) => r.id);
  return {
    config: { version: 2, defaultRole, roles, assignments: stored.assignments, legacyFullIds: stored.legacyFullIds },
    removed,
  };
}
