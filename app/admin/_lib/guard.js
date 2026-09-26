import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { isAdmin } from '@/lib/auth-allowlist';

/**
 * The admin gate, for every admin page and data-loading layout — not only
 * app/admin/layout.js. A layout is not re-rendered on client navigation
 * between its children, and a request for one segment's payload does not
 * run the layouts above it, so a check made only there would not stand in
 * front of the data a page loads.
 *
 * Admin access is env-gated (ADMIN_EMAILS), independent of roles, so a
 * misconfigured role can never lock admins out of the panel that fixes it.
 * Returns the admin's email.
 */
export async function requireAdminPage(back = '/admin') {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect(`/signin?callbackUrl=${encodeURIComponent(back)}`);
  if (!isAdmin(email)) redirect('/files');
  return String(email).toLowerCase();
}
