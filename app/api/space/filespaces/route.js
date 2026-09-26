import { NextResponse } from 'next/server';
import { requireDesktopAuth } from '@/lib/desktop-guard';
import { listFilespaces, listFilespacesForUser } from '@/lib/db';
import { can } from '@/lib/authz';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET — the filespaces the calling desktop user may mount.
 * Admins (ADMIN_EMAILS) see all, as owner; everyone else sees exactly the
 * drives they are a member of, each at their role after the ceiling their
 * platform role sets — a Viewer granted editor mounts read-only.
 * Returns only what the picker needs — never roleArn / createdBy.
 *
 * A full-access platform role used to list every drive here, and only here:
 * the web and the sync feed showed those people a drive's files only as a
 * member, so the apps had to be told which drives were real (`member`). Now
 * the list is the membership, so `member` is always true; it stays in the
 * response for the clients that read it.
 */
export async function GET(req) {
  const gate = await requireDesktopAuth(req);
  if (gate.error) return gate.error;
  const { principal } = gate;
  // The `filespaces` flag switches the whole data plane off, read here.
  const allowed = can(principal, 'desktop.mount');
  if (!allowed.ok) return NextResponse.json({ error: allowed.reason }, { status: allowed.status });

  const spaces = principal.isAdmin
    ? (await listFilespaces()).map((f) => ({ ...f, role: 'owner' }))
    : (await listFilespacesForUser(gate.email))
      .map((f) => ({ ...f, role: principal.driveScope?.roles?.[f.id] || null }))
      .filter((f) => f.role);

  const filespaces = spaces.map((f) => ({
    id: f.id, name: f.name, bucket: f.bucket, prefix: f.prefix, region: f.region || null, role: f.role || 'viewer',
    member: true,
  }));
  return NextResponse.json({ filespaces, email: gate.email, isAdmin: principal.isAdmin });
}
