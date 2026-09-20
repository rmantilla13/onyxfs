import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getFeatureFlags, setFeatureFlags } from '@/lib/db';
import { FEATURE_FLAGS, DEFAULT_FLAGS, mergeFlags } from '@/lib/features';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET → the registry plus the currently effective map. */
export async function GET() {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  return NextResponse.json({
    registry: FEATURE_FLAGS,
    defaults: DEFAULT_FLAGS,
    flags: await getFeatureFlags(),
  });
}

/** PUT { flags } — merged over the defaults, so a partial map is fine. */
export async function PUT(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const flags = mergeFlags(body.flags);
  await setFeatureFlags(flags, guard.email);
  return NextResponse.json({ flags });
}
