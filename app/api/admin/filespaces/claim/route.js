import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { claimOwnerlessDrives } from '@/lib/db';
import { auditDriveClaims } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// As many as Admin → Drives lists (listDrivesWithUsage, LIMIT 500).
const MAX = 500;

/**
 * POST { ids: [...] } → { claimed: [{ id, name }], skipped: [id] }
 *
 * Make the admin asking the owner of each of these drives that has no owner:
 * the fix beside Admin → Overview's "no owner" item and the same notice on
 * Drives. A drive always has an owner (lib/drive-access.js); these are the
 * ones from before that, or from two owners removed at the same instant.
 *
 * The ids are the drives the confirm named, and only those change: one that
 * has an owner by now, or is gone, is skipped rather than claimed, and a
 * drive left without one since the page was drawn waits for a confirm that
 * names it. Nobody's access changes — an admin reaches every drive already —
 * so this is a statement of whose the drive is, and it is recorded as one.
 */
export async function POST(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const ids = Array.isArray(body?.ids) ? [...new Set(body.ids.map(String).filter(Boolean))] : [];
  if (!ids.length) return NextResponse.json({ error: 'ids must be a non-empty list of drive ids.' }, { status: 400 });
  if (ids.length > MAX) return NextResponse.json({ error: `Claim at most ${MAX} drives at once.` }, { status: 400 });

  const claimed = await claimOwnerlessDrives(ids, guard.email);
  await auditDriveClaims(guard.email, claimed);
  return NextResponse.json(
    { claimed, skipped: ids.filter((id) => !claimed.some((d) => d.id === id)) },
    { headers: { 'cache-control': 'no-store' } },
  );
}
