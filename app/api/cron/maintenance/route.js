import { NextResponse } from 'next/server';
import { runMaintenance } from '@/lib/maintenance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Daily maintenance: the schema guards, the trash purge, abandoned uploads,
 * usage-rights notices and the audit trail's retention. The work is
 * lib/maintenance.js runMaintenance — shared with an admin's Run now, and
 * recorded in maintenance_runs either way.
 *
 * Bearer-authed with CRON_SECRET; the middleware excludes /api/cron.
 */
export async function GET(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // 200 whatever happened: the run is recorded with its errors, and a cron
  // that retried on failure would only repeat a purge that half worked.
  return NextResponse.json(await runMaintenance({ trigger: 'cron' }));
}
