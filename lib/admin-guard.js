import { auth } from '@/auth';
import { isAdmin, isSuperAdmin } from '@/lib/auth-allowlist';
import { NextResponse } from 'next/server';

/**
 * Use at the top of any /api/admin route handler:
 *
 *   const guard = await requireAdmin();
 *   if (guard.error) return guard.error;
 *   const { email } = guard;
 *
 * Returns {email} on success, {error: NextResponse} on failure.
 */
export async function requireAdmin() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  }
  if (!isAdmin(email)) {
    return { error: NextResponse.json({ error: 'Admin access required' }, { status: 403 }) };
  }
  return { email };
}

/**
 * Stricter gate for the most sensitive surfaces (Brand & white-label).
 * Only super-admins (the owner accounts) pass.
 */
export async function requireSuperAdmin() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  }
  if (!isSuperAdmin(email)) {
    return { error: NextResponse.json({ error: 'Super-admin access required' }, { status: 403 }) };
  }
  return { email };
}
