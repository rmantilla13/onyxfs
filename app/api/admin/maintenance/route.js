import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { listMaintenanceRuns } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** GET → { runs } — the last ten maintenance runs, newest first, for Health. */
export async function GET() {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  return NextResponse.json({ runs: await listMaintenanceRuns({ limit: 10 }) });
}
