import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/session';
import { isAdmin, isSuperAdmin } from '@/lib/auth-allowlist';

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
  // The session as every page has it (lib/session.js): signed in, not
  // suspended, and not signed out everywhere since.
  const user = await getSessionUser();
  const email = user?.email;
  if (!email) redirect(`/signin?callbackUrl=${encodeURIComponent(back)}`);
  if (!isAdmin(email)) redirect('/files');
  return String(email).toLowerCase();
}

/**
 * The same, for what only a super-admin may see: the storage backend every
 * file lives in (SUPER_ADMIN_EMAILS, or every admin when that is unset). The
 * routes behind it refuse anyone else too; an admin who is not one is sent
 * to the Overview rather than shown a page that cannot load.
 */
export async function requireSuperAdminPage(back = '/admin') {
  const email = await requireAdminPage(back);
  if (!isSuperAdmin(email)) redirect('/admin');
  return email;
}

/** Is this admin a super-admin? For the rail, which offers Backend only to them. */
export function adminIsSuper(email) {
  return !!email && isSuperAdmin(email);
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
  const user = await getSessionUser().catch(() => null);
  const email = user?.email;
  return !!email && isAdmin(email);
}
