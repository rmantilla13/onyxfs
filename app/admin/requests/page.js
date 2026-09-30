import { listInviteRequests, listSignInPasswordHolders } from '@/lib/db';
import { isAdmin } from '@/lib/auth-allowlist';
import { requestFilter, requestCounts, requestsFor } from '@/lib/admin-requests';
import { requireAdminPage } from '../_lib/guard';
import RequestsClient from './RequestsClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Access requests · Admin' };

/**
 * Admin → Access requests: who may sign in — the people admins added, and
 * the requests made before the sign-in page stopped taking them. It uses the invite API as it is (approve, deny, add, revoke),
 * and /api/admin/passwords for the accounts that sign in with a password (App Review's);
 * choosing a role and drives on approval, and the "You're in" email, come
 * with Phase 1's extension of that API.
 */
export default async function RequestsPage({ searchParams }) {
  const me = await requireAdminPage('/admin/requests');
  const status = requestFilter(searchParams?.status);
  const [all, holders] = await Promise.all([
    listInviteRequests(),
    // Who has a sign-in password — never the hash. Not worth failing the
    // page over: without it the rows only lose their Password tag.
    listSignInPasswordHolders().catch((e) => {
      console.warn('[admin] could not list sign-in passwords:', e.message);
      return [];
    }),
  ]);
  const passwords = new Map(holders.map((h) => [h.email, { setAt: h.setAt, setBy: h.setBy }]));
  const rows = requestsFor(all, status).map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name || null,
    reason: r.reason || null,
    status: r.status,
    requestedAt: r.requestedAt,
    reviewedAt: r.reviewedAt,
    reviewedBy: r.reviewedBy || null,
    reviewNote: r.reviewNote || null,
    requestCount: r.requestCount ?? null,
    // Admins are made in ADMIN_EMAILS, not here, and nobody revokes themselves.
    envAdmin: isAdmin(r.email),
    self: String(r.email || '').toLowerCase() === me,
    // { setAt, setBy } when an admin gave them a password to sign in with.
    password: passwords.get(String(r.email || '').toLowerCase()) || null,
  }));
  return <RequestsClient status={status} rows={rows} counts={requestCounts(all)} />;
}
