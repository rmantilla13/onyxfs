import { NextResponse } from 'next/server';
import { requireDesktopAuth } from '@/lib/desktop-guard';
import { listFilespaces, listFilespacesForUser } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET — the filespaces the calling desktop user may mount.
 * Admins see all (as owner); everyone else sees only their grants.
 * Returns only what the picker needs — never roleArn / createdBy.
 */
export async function GET(req) {
  const gate = await requireDesktopAuth(req);
  if (gate.error) return gate.error;

  const spaces = gate.isAdmin
    ? (await listFilespaces()).map((f) => ({ ...f, role: 'owner' }))
    : await listFilespacesForUser(gate.email);

  const filespaces = spaces.map((f) => ({
    id: f.id, name: f.name, bucket: f.bucket, prefix: f.prefix, region: f.region || null, role: f.role || 'viewer',
  }));
  return NextResponse.json({ filespaces, email: gate.email, isAdmin: gate.isAdmin });
}
