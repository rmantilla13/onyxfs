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
 */
export async function requireAdmin() {
  const user = await getSessionUser();
  const email = user?.email;
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
