// lib/user-flags.js — one person's feature flags, for a route to enforce.
//
// The files page computes this for rendering; a route that changes behaviour
// behind a flag has to compute it again rather than take the client's word
// (see "Enforce feature flags on the server" in AGENTS.md). Same order as the
// page: global flags → admin beta overrides → narrowed by role, which can
// only take features away.

import { getFeatureFlags, getRolesConfig } from './db.js';
import { isAdmin } from './auth-allowlist.js';
import { resolveRole, effectiveFlags } from './roles.js';
import { applyBetaAdminFlags } from './features.js';

export async function flagsForUser(email) {
  const admin = isAdmin(email);
  const [globalFlags, rolesConfig] = await Promise.all([getFeatureFlags(), getRolesConfig()]);
  const role = resolveRole(email, rolesConfig, { isAdmin: admin });
  return { flags: effectiveFlags(applyBetaAdminFlags(globalFlags, admin), role), role, admin };
}
