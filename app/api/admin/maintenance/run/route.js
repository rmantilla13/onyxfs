import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { runMaintenance } from '@/lib/maintenance';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST — run maintenance now: the same run the daily cron makes
 * (lib/maintenance.js), recorded with who started it. For after a deploy
 * that added a table, instead of waiting for the cron or running
 * `npm run doctor` against production.
 */
export async function POST() {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  const result = await runMaintenance({ trigger: 'admin', by: guard.email });
  await audit(guard.email, 'maintenance.run', { type: 'maintenance', id: result.id || 'run', label: 'Maintenance' }, {
    ok: result.ok, purged: result.purged, errors: result.errors.length, schemaFailures: result.schema.length,
  });
  return NextResponse.json(result);
}
