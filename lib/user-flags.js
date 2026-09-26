// lib/user-flags.js — one person's feature flags, for a route to enforce.
//
// The files page computes this for rendering; a route that changes behaviour
// behind a flag has to compute it again rather than take the client's word
// (see "Enforce feature flags on the server" in AGENTS.md). Both read the
// principal lib/authz.js builds, so they cannot disagree: global flags,
// admin beta overrides, and a flag whose every capability the role lacks
// reading as off.

import { getPrincipal } from './authz.js';

export async function flagsForUser(email, principal = null) {
  const p = principal || await getPrincipal(email);
  return { flags: p.flags, role: p.role, admin: p.isAdmin, principal: p };
}
