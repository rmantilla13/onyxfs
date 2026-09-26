import { redirect } from 'next/navigation';
import { listInviteRequests, listDrivesWithUsage, usageTotals } from '@/lib/db';
import { legacyAdminTab } from '@/lib/admin-redirects';
import { requireAdminPage } from './_lib/guard';
import Overview from './Overview';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin' };

/**
 * Admin → Overview: the numbers worth a glance and what needs doing.
 *
 * The tiles are the ones the data supports today — access requests, storage
 * and its trash, drives, and health. Three more arrive with Phase 1 and go
 * in Overview.js where it says so: people active in the last 7 days, AI
 * spend this month, and live public links.
 */
export default async function OverviewPage({ searchParams }) {
  // The panel used to be one page with tabs; their links still arrive here.
  const legacy = legacyAdminTab(searchParams?.tab);
  if (legacy) redirect(legacy);

  await requireAdminPage('/admin');
  const [pending, drives, totals] = await Promise.all([
    listInviteRequests({ status: 'pending' }),
    listDrivesWithUsage(),
    usageTotals(),
  ]);

  return (
    <Overview
      pending={pending.map((r) => ({ id: r.id, email: r.email, name: r.name || null }))}
      drives={{
        count: drives.length,
        withoutOwner: drives.filter((d) => !d.ownerCount).map((d) => ({ id: d.id, name: d.name })),
      }}
      totals={totals}
    />
  );
}
