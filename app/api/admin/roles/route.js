import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getRolesConfig, setRolesConfig } from '@/lib/db';
import { mergeRolesConfig, BUILTIN_ROLES } from '@/lib/roles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  return NextResponse.json({ config: mergeRolesConfig(await getRolesConfig()), builtin: BUILTIN_ROLES });
}

/**
 * PUT { roles, assignments, defaultRole }
 *
 * mergeRolesConfig guarantees a full-access role survives the write. Without
 * that, saving a config with no admin role would lock every admin out of the
 * panel needed to undo it.
 */
export async function PUT(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const config = mergeRolesConfig(body);
  await setRolesConfig(config, guard.email);
  return NextResponse.json({ config });
}
