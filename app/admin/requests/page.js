import { listInviteRequests } from '@/lib/db';
import { isAdmin } from '@/lib/auth-allowlist';
import { requestFilter, requestCounts, requestsFor } from '@/lib/admin-requests';
import { requireAdminPage } from '../_lib/guard';
import RequestsClient from './RequestsClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Access requests' };

/**
 * Admin → Access requests: the people who asked to sign in, and the
 * decision. It uses the invite API as it is (approve, deny, add, revoke);
 * choosing a role and drives on approval, and the "You're in" email, come
 * with Phase 1's extension of that API.
 */
export default async function RequestsPage({ searchParams }) {
  const me = await requireAdminPage('/admin/requests');
  const status = requestFilter(searchParams?.status);
  const all = await listInviteRequests();
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
  }));
  return <RequestsClient status={status} rows={rows} counts={requestCounts(all)} />;
}
