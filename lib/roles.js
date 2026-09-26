// lib/roles.js — role-based feature access.
//
// A role bundles a set of allowed features; people are assigned to a role. At
// render time someone's visible features = the GLOBAL feature flags narrowed by
// their role. The invariant that makes this safe to reason about: a role can
// only take features away, never add one the platform has globally off.
//
// Stored as one settings blob under 'roles.config':
//   { roles: [{ id, name, description, full?, features: { key: false } }],
//     assignments: { "someone@example.com": "roleId" },
//     defaultRole: "member" }
//
// Roles govern feature VISIBILITY. Admin-panel access stays env-gated via
// ADMIN_EMAILS, deliberately: a misconfigured role must never be able to lock
// every admin out of the panel that would let them fix it.
//
// Filespace access is a separate axis and is NOT expressed here — it is a
// per-filespace grant in the `filespace_access` table. A role decides which
// parts of Onyx someone sees; a grant decides which storage they can reach.

import { FEATURE_FLAGS } from './features.js';

/** Deny the listed flags, keep everything else. */
function deny(list, extra = {}) {
  const f = { ...extra };
  for (const k of list) f[k] = false;
  return f;
}

/** Deny everything except the listed flags. */
function grantOnly(grant, extra = {}) {
  const keep = new Set(grant);
  const f = { ...extra };
  for (const flag of FEATURE_FLAGS) if (!keep.has(flag.key)) f[flag.key] = false;
  return f;
}

export const BUILTIN_ROLES = [
  {
    id: 'admin',
    name: 'Admin',
    description: 'Full access — every feature, every filespace, plus the admin panel.',
    full: true,
    features: {},
    builtin: true,
  },
  {
    id: 'member',
    name: 'Member',
    description:
      'The default. Browse and upload to any filespace they are granted, edit metadata, and share. Cannot change storage or access settings.',
    features: {},
    builtin: true,
  },
  {
    id: 'contributor',
    name: 'Contributor',
    description:
      'Upload and organize, but cannot hand work outside the org: no public share links and no folder-level grants.',
    features: deny(['shares', 'folderAcl']),
    builtin: true,
  },
  {
    id: 'viewer',
    name: 'Viewer',
    description:
      'Read-only. Browse and download what they are granted, comment and approve, with no sharing, no metadata editing, and no trash.',
    // Review is kept: comment and approve are what a stakeholder who only
    // reads is there to do, and neither changes a file.
    features: grantOnly(['notifications', 'thumbnails', 'usageRights', 'review']),
    builtin: true,
  },
];

export const DEFAULT_ROLES_CONFIG = {
  roles: BUILTIN_ROLES,
  assignments: {},
  defaultRole: 'member',
};

const clone = (o) => JSON.parse(JSON.stringify(o));

export function mergeRolesConfig(saved) {
  if (!saved || typeof saved !== 'object') return clone(DEFAULT_ROLES_CONFIG);
  const roles = Array.isArray(saved.roles) && saved.roles.length ? clone(saved.roles) : clone(BUILTIN_ROLES);
  // Fold in any builtin role the saved config predates, so a deploy that adds
  // one picks it up without clobbering custom roles or edited assignments. A
  // saved copy of a builtin (same id) wins, so admin tweaks survive.
  const haveIds = new Set(roles.map((r) => r.id));
  for (const b of BUILTIN_ROLES) if (!haveIds.has(b.id)) roles.push(clone(b));
  // Always guarantee a full-access role exists — see the lock-out note above.
  if (!roles.some((r) => r.full)) roles.unshift(clone(BUILTIN_ROLES[0]));
  return {
    roles,
    assignments: saved.assignments && typeof saved.assignments === 'object' ? saved.assignments : {},
    defaultRole: typeof saved.defaultRole === 'string' ? saved.defaultRole : 'member',
  };
}

/** Resolve the role for an email. Env-admins always get the full admin role. */
export function resolveRole(email, config, { isAdmin = false } = {}) {
  const cfg = mergeRolesConfig(config);
  if (isAdmin) {
    return cfg.roles.find((r) => r.full) || { id: 'admin', full: true, features: {} };
  }
  const e = String(email || '').trim().toLowerCase();
  const id = cfg.assignments[e] || cfg.defaultRole;
  return cfg.roles.find((r) => r.id === id) || cfg.roles.find((r) => r.id === cfg.defaultRole) || cfg.roles[0];
}

export function roleAllows(role, key) {
  if (!role || role.full) return true;
  return role.features?.[key] !== false;
}

/**
 * Narrow a global feature-flag map by a role. A role can only DISABLE a
 * feature, never enable one that is globally off.
 */
export function effectiveFlags(globalFlags, role) {
  const base = globalFlags || {};
  if (!role || role.full) return base;
  const out = { ...base };
  for (const f of FEATURE_FLAGS) {
    if (role.features?.[f.key] === false) out[f.key] = false;
  }
  return out;
}

/**
 * Whether a role may write at all. Used as a cheap pre-check before the
 * per-filespace role (viewer/editor/owner) is consulted — a Viewer in Onyx
 * cannot write even to a filespace that granted them editor.
 */
export function roleCanWrite(role) {
  if (!role) return false;
  if (role.full) return true;
  return role.id !== 'viewer';
}
