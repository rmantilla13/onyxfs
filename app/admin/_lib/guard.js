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

/**
 * Is the signed-in viewer an admin? For generateMetadata, which Next.js
 * runs alongside the page — even for a request the page turns away — and
 * whose title reaches the response before the page's redirect does. It
 * must not read anything for a viewer who is not an admin, so a drive's
 * name (or whether its id exists) never lands in a stranger's <title>.
 * No redirect here: that is the page's job.
 */
export async function viewerIsAdmin() {
  const session = await auth().catch(() => null);
  const email = session?.user?.email;
  return !!email && isAdmin(email);
}
