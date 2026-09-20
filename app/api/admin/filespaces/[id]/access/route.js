import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { grantFilespaceAccess, revokeFilespaceAccess, isFilespaceRole, getFilespaceById } from '@/lib/db';
import { isAdmin } from '@/lib/auth-allowlist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH { email, role?, grant }  — manage one user's access to a filespace.
 *   grant !== false → upsert the grant at `role` (default 'viewer').
 *   grant === false → revoke.
 * Env-admins are never persisted as grant rows (they already reach everything).
 */
export async function PATCH(req, { params }) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  const filespaceId = params?.id;
  if (!filespaceId) return NextResponse.json({ error: 'filespace id required' }, { status: 400 });
  // Don't write grants against a non-existent filespace (avoids orphan rows).
  const fs = await getFilespaceById(filespaceId);
  if (!fs) return NextResponse.json({ error: 'Filespace not found' }, { status: 404 });

  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return NextResponse.json({ error: 'email required' }, { status: 400 });

  const grant = body.grant !== false;
  if (!grant) {
    await revokeFilespaceAccess({ filespaceId, email });
    return NextResponse.json({ ok: true, email, revoked: true });
  }

  if (isAdmin(email)) {
    return NextResponse.json({ error: 'This user is an env-level admin — they already have access to every filespace.' }, { status: 400 });
  }
  const role = String(body.role || 'viewer');
  if (!isFilespaceRole(role)) return NextResponse.json({ error: 'Unknown role' }, { status: 400 });

  const member = await grantFilespaceAccess({ filespaceId, email, role, grantedBy: gate.email });
  return NextResponse.json({ ok: true, member });
}
