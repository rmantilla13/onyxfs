import { NextResponse } from 'next/server';
import { requireDesktopAuth } from '@/lib/desktop-guard';
import { listFilespaces, listFilespacesForUser } from '@/lib/db';
import { isAdmin as isEnvAdmin } from '@/lib/auth-allowlist';

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

  // `member`: whether the drive's files are theirs to see in the web and in
  // the sync feed. A full-role admin mounts every drive here (above) but, on
  // the web and in /api/files/delta, sees a drive's files only as a member
  // (drives are boundaries; admin is ADMIN_EMAILS) — so a client offering
  // Finder locations offers these only.
  let memberOf = null;
  if (gate.isAdmin && !isEnvAdmin(gate.email)) {
    memberOf = new Set((await listFilespacesForUser(gate.email)).map((f) => f.id));
  }

  const filespaces = spaces.map((f) => ({
    id: f.id, name: f.name, bucket: f.bucket, prefix: f.prefix, region: f.region || null, role: f.role || 'viewer',
    member: memberOf ? memberOf.has(f.id) : true,
  }));
  return NextResponse.json({ filespaces, email: gate.email, isAdmin: gate.isAdmin });
}
