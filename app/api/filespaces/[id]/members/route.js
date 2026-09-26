import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { isAdmin, isEmailGrantedAccess } from '@/lib/auth-allowlist';
import {
  getFilespaceById, getFilespaceRole, listFilespaceMembers, grantFilespaceAccess,
  revokeFilespaceAccess, listInviteRequests, filespaceMemberDecision,
} from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Who may manage a filespace's members: admins (every filespace) and the
 * filespace's own owners — the one route for it, used by the drive menu on
 * the files page and by the drive drawer in Admin → Drives.
 */
async function gate(id) {
  const session = await auth();
  const email = String(session?.user?.email || '').toLowerCase();
  if (!email) return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  const admin = isAdmin(email);
  const fs = id ? await getFilespaceById(id) : null;
  // A non-member learns nothing about whether the id exists.
  const role = admin ? 'owner' : (fs ? await getFilespaceRole({ filespaceId: id, email }) : null);
  if (!fs || (!admin && !role)) return { error: NextResponse.json({ error: 'Drive not found' }, { status: 404 }) };
  if (!admin && role !== 'owner') {
    return { error: NextResponse.json({ error: 'Only admins and owners of this drive can manage its members.' }, { status: 403 }) };
  }
  return { email, admin, role, fs };
}

/** GET → { filespace, members, users, self } for the members dialog. */
export async function GET(_req, { params }) {
  const g = await gate(params?.id);
  if (g.error) return g.error;
  const members = (await listFilespaceMembers(g.fs.id)).map((m) => ({ ...m, envAdmin: isAdmin(m.email) }));
  // Suggestions for the add field: everyone with an approved invite who is
  // not already a member. Best-effort, same source the Admin panel used.
  const have = new Set(members.map((m) => m.email));
  const users = [];
  try {
    for (const i of await listInviteRequests({ status: 'approved' })) {
      const e = String(i.email || '').toLowerCase();
      if (e && !have.has(e) && !isAdmin(e)) { have.add(e); users.push({ email: e, name: i.name || null }); }
    }
  } catch {}
  return NextResponse.json({
    filespace: { id: g.fs.id, name: g.fs.name, bucket: g.fs.bucket, prefix: g.fs.prefix },
    members,
    users,
    self: { email: g.email, isAdmin: g.admin, role: g.role },
  });
}

/** PATCH { email, role?, grant } → upsert (grant !== false) or revoke one member. */
export async function PATCH(req, { params }) {
  const g = await gate(params?.id);
  if (g.error) return g.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const email = String(body.email || '').trim().toLowerCase();
  const grant = body.grant !== false;
  const role = String(body.role || 'viewer');

  const denied = filespaceMemberDecision({
    actor: { email: g.email, isAdmin: g.admin },
    actorRole: g.role,
    targetEmail: email,
    targetIsAdmin: isAdmin(email),
    targetCanSignIn: grant && !g.admin ? await isEmailGrantedAccess(email) : true,
    grant,
    role,
  });
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  if (!grant) {
    await revokeFilespaceAccess({ filespaceId: g.fs.id, email });
    return NextResponse.json({ ok: true, email, revoked: true });
  }
  const member = await grantFilespaceAccess({ filespaceId: g.fs.id, email, role, grantedBy: g.email });
  return NextResponse.json({ ok: true, member });
}
