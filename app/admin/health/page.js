import { requireAdminPage } from '../_lib/guard';
import HealthClient from './HealthClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Health · Admin' };

/**
 * Admin → Health: /api/health as a check list. The checks run in the
 * browser against the route, the same one a monitor or a curl with
 * CRON_SECRET reads, so this page and they cannot disagree.
 *
 * The maintenance card (last runs, Run now) comes with Phase 1's
 * maintenance_runs table.
 */
export default async function HealthPage() {
  await requireAdminPage('/admin/health');
  return <HealthClient />;
}
