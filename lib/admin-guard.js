import { NextResponse } from 'next/server';
import { isAdmin, isSuperAdmin } from '@/lib/auth-allowlist';
import { getSessionUser } from '@/lib/session';

/**
 * Use at the top of any /api/admin route handler:
 *
 *   const guard = await requireAdmin();
 *   if (guard.error) return guard.error;
 *   const { email } = guard;
 *
 * Returns {email, user} on success, {error: NextResponse} on failure.
 *
 * Admin is ADMIN_EMAILS and nothing else — never a role, so a misconfigured
 * role cannot lock every admin out of the panel that would fix it. The
 * session still has to pass getSessionUser (signed out everywhere, say).
 *
 * A route that hands over its request (`requireAdmin(req)`) also takes Onyx
 * for Mac's bearer token when there is no session — only trash/restore, for
 * Put Back in Finder. The address behind the token is held to exactly the
 * same test, and the token to lib/authz.js principalFromToken's (a live
 * device, a role allowed the desktop app). Every other admin route passes
 * nothing and stays session-only; middleware lets a token through to no
 * other (lib/bearer-gate.js). `user` is null for a token.
 */
export async function requireAdmin(req = null) {
  const user = await getSessionUser();
  let email = user?.email;
  if (!email && req) {
    const { principalFromToken } = await import('@/lib/authz');
    const token = await principalFromToken(req);
    if (token?.error) return { error: token.error };
    email = token?.email;
  }
  if (!email) {
    return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  }
  if (!isAdmin(email)) {
    return { error: NextResponse.json({ error: 'Admin access required' }, { status: 403 }) };
  }
  return { email, user };
}

/**
 * Stricter gate for the surfaces that can break the deployment or run up a
 * bill: the storage backend, and the AI key and budget. SUPER_ADMIN_EMAILS,
 * or every admin when it is unset (lib/auth-allowlist.js).
 */
export async function requireSuperAdmin() {
  const user = await getSessionUser();
  const email = user?.email;
  if (!email) {
    return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  }
  if (!isSuperAdmin(email)) {
    return { error: NextResponse.json({ error: 'Super-admin access required' }, { status: 403 }) };
  }
  return { email, user };
}
