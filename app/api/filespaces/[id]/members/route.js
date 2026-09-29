import { NextResponse } from 'next/server';
import { isAdmin, isEmailGrantedAccess } from '@/lib/auth-allowlist';
import {
  getFilespaceById, listFilespaceMembers, grantFilespaceAccess,
  revokeFilespaceAccess, listInviteRequests, filespaceMemberDecision,
} from '@/lib/db';
import { requirePrincipal, can, driveRoleOf } from '@/lib/authz';
import { ownerOfLastResort, lastOwnerRefusal } from '@/lib/drive-access';
import { audit, auditDriveClaims, personSubject } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Who may manage a filespace's members: admins (every filespace) and the
 * filespace's own owners — owner after the ceiling their platform role sets,
 * so a Viewer granted owner manages nothing. The one route for it, used by
 * the drive menu on the files page and by the drive drawer in Admin → Drives.
 */
async function gate(id) {
  const g = await requirePrincipal();
  if (g.error) return g;
  const { principal, email } = g;
  const admin = principal.isAdmin;
  const fs = id ? await getFilespaceById(id) : null;
  // A non-member learns nothing about whether the id exists.
  const role = fs ? driveRoleOf(principal, id) : null;
  if (!fs || !role) return { error: NextResponse.json({ error: 'Drive not found' }, { status: 404 }) };
  const d = can(principal, 'drive.manageMembers', { driveRole: role });
  if (!d.ok) return { error: NextResponse.json({ error: d.reason }, { status: d.status }) };
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

/**
 * PATCH { email, role?, grant } → upsert (grant !== false) or revoke one member.
 *
 * Never leaves the drive with no owner (lib/drive-access.js). Removing its
 * last owner, or making them an editor or a viewer, makes the admin doing
 * it the owner in the same statement, and says so (`claimedBy`); from anyone
 * else, or an admin who is that last owner, it is refused (409).
 */
export async function PATCH(req, { params }) {
  const g = await gate(params?.id);
  if (g.error) return g.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const email = String(body.email || '').trim().toLowerCase();
  const grant = body.grant !== false;
  const role = String(body.role || 'viewer');
  const actor = { email: g.email, isAdmin: g.admin };

  const denied = filespaceMemberDecision({
    actor,
    actorRole: g.role,
    targetEmail: email,
    targetIsAdmin: isAdmin(email),
    targetCanSignIn: grant && !g.admin ? await isEmailGrantedAccess(email) : true,
    grant,
    role,
  });
  if (denied) return NextResponse.json({ error: denied.error }, { status: denied.status });

  const fallbackOwner = ownerOfLastResort({ actor, targetEmail: email });
  const lastOwner = () => NextResponse.json({ error: lastOwnerRefusal({ actor, targetEmail: email }), code: 'last_owner' }, { status: 409 });
  const claimed = [{ id: g.fs.id, name: g.fs.name }];
  if (!grant) {
    const r = await revokeFilespaceAccess({ filespaceId: g.fs.id, email, fallbackOwner });
    if (r.refused) return lastOwner();
    await audit(g.email, 'drive.revoke', { type: 'drive', id: g.fs.id, label: g.fs.name }, { person: email });
    if (r.claimedBy) await auditDriveClaims(g.email, claimed, { from: email });
    return NextResponse.json({ ok: true, email, revoked: true, claimedBy: r.claimedBy });
  }
  const r = await grantFilespaceAccess({ filespaceId: g.fs.id, email, role, grantedBy: g.email, fallbackOwner });
  if (r.refused) return lastOwner();
  await audit(g.email, 'drive.grant', personSubject(email), { driveId: g.fs.id, drive: g.fs.name, role });
  if (r.claimedBy) await auditDriveClaims(g.email, claimed, { from: email });
  return NextResponse.json({ ok: true, member: r.member, claimedBy: r.claimedBy });
}
