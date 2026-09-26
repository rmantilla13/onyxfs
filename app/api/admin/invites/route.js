import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import {
  listInviteRequests, updateInviteRequest, adminAddApprovedInvite, deleteInviteRequest, removePerson,
  isInviteStatus, INVITE_STATUSES, upsertPerson, updatePerson, getPersonByEmail,
} from '@/lib/db';
import { isAdmin } from '@/lib/auth-allowlist';
import { forgetSession } from '@/lib/session';
import {
  loadRolesAndPolicy, assignableRole, parseEmails, parseGrants, applyGrantDiff, personActionProblem,
} from '@/lib/people';
import { audit, personSubject } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vercel's default ceiling is 300s. Nothing here should take anywhere near
// that: every query in lib/db.js is bounded at 15s by the driver. A cap keeps
// a pathological request costing seconds instead of five minutes of a hung
// invocation — which is what the gateway timeouts on this route looked like.
export const maxDuration = 30;

const MAX_INVITES = 100;

export async function GET(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  const status = new URL(req.url).searchParams.get('status') || undefined;
  if (status && !isInviteStatus(status)) {
    return NextResponse.json({ error: `Status must be one of: ${INVITE_STATUSES.join(', ')}.` }, { status: 400 });
  }
  return NextResponse.json({ requests: await listInviteRequests({ status }) });
}

/**
 * POST — add people directly, skipping the request queue.
 *
 *   { emails: [..] | "a@x.com, b@y.com", roleId?, grants?: [{ filespaceId, role }], sendEmail? }
 *   { email, name }   the original single-address form, still accepted
 *
 * Each address gets an approved invite and a people row, the role if one is
 * given, and the drive grants. `sendEmail` is accepted for the dialog that
 * will send it; the "You're in" email itself arrives with the admin
 * overhaul (lib/access-email.js), so for now `emailed` is always false and
 * the response says so rather than pretending.
 */
export async function POST(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }

  const { emails, invalid } = parseEmails(body.emails ?? body.email);
  if (invalid.length) return NextResponse.json({ error: `Not an email address: ${invalid.slice(0, 5).join(', ')}` }, { status: 400 });
  if (!emails.length) return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 });
  if (emails.length > MAX_INVITES) return NextResponse.json({ error: `Invite at most ${MAX_INVITES} people at once.` }, { status: 400 });

  let roleId = null;
  if (body.roleId != null && body.roleId !== '') {
    let rolesConfig;
    try { ({ rolesConfig } = await loadRolesAndPolicy()); } catch {
      return NextResponse.json({ error: 'Could not read the roles, so nobody was invited. Try again.' }, { status: 503 });
    }
    if (!assignableRole(rolesConfig, String(body.roleId))) {
      return NextResponse.json({ error: `"${body.roleId}" is not a role that can be assigned.` }, { status: 400 });
    }
    roleId = String(body.roleId);
  }
  const parsedGrants = await parseGrants(body.grants);
  if (parsedGrants.error) return NextResponse.json({ error: parsedGrants.error }, { status: 400 });

  const invited = [];
  for (const email of emails) {
    const row = await adminAddApprovedInvite({ email, name: emails.length === 1 ? body.name || null : null, reviewedBy: guard.email });
    await upsertPerson(email, { roleId });
    // An existing person keeps their row; a role given here is still applied
    // to them, unless they are an env admin, whose role is not ours to set.
    if (roleId && !isAdmin(email)) {
      const person = await getPersonByEmail(email);
      if (person && person.roleId !== roleId) await updatePerson(email, { roleId });
    }
    // Admins already reach every drive; a grant row for one is noise.
    const grants = isAdmin(email) ? { granted: [], revoked: [] }
      : await applyGrantDiff(email, [], parsedGrants.grants, guard.email);
    await audit(guard.email, 'invite.add', personSubject(email), {
      roleId, drives: grants.granted, sendEmail: !!body.sendEmail,
    });
    invited.push({ email, status: row.status, roleId, drives: grants.granted });
  }
  return NextResponse.json({
    request: invited.length === 1 ? { email: invited[0].email, status: invited[0].status } : undefined,
    invited,
    emailed: false,
  });
}

/**
 * PATCH { id, status, note } — approve, deny, or put back to pending. Only
 * those three: anything else was stored as sent and, since only 'approved'
 * lets anyone in, quietly revoked them. Approving makes sure the person has
 * a row, which is where their role and limits will live.
 */
export async function PATCH(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  if (!isInviteStatus(body.status)) {
    return NextResponse.json({ error: `Status must be one of: ${INVITE_STATUSES.join(', ')}.` }, { status: 400 });
  }
  const note = body.note == null ? null : String(body.note).slice(0, 1000);
  const row = await updateInviteRequest(body.id, { status: body.status, reviewedBy: guard.email, reviewNote: note });
  if (!row) return NextResponse.json({ error: 'Request not found' }, { status: 404 });
  if (row.status === 'approved') await upsertPerson(row.email);
  // A denial or a step back to pending closes the door now, not in 30s.
  else forgetSession(row.email);
  const action = { approved: 'invite.approve', denied: 'invite.deny', pending: 'invite.pending' }[row.status];
  await audit(guard.email, action, personSubject(row.email, row.name || row.email), note ? { note } : null);
  return NextResponse.json({ request: row });
}

/**
 * DELETE ?email= — remove the person: sign-in, drive grants, devices, links
 * and their rows (removePerson in lib/db.js says exactly what). Their files
 * stay. Env admins are managed in ADMIN_EMAILS, and nobody removes
 * themselves.
 *
 * DELETE ?id= — drop one request row and nothing else, for clearing the
 * queue of a request that was never approved.
 */
export async function DELETE(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  const url = new URL(req.url);
  const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
  const id = url.searchParams.get('id');
  if (!email && !id) return NextResponse.json({ error: 'email or id required' }, { status: 400 });
  if (email) {
    const problem = personActionProblem({ actor: guard.email, target: email, action: 'remove' });
    if (problem) return NextResponse.json({ error: problem.error }, { status: problem.status });
    const result = await removePerson(email, { apply: true });
    forgetSession(email);
    await audit(guard.email, 'person.remove', personSubject(email), result);
    return NextResponse.json({ ok: true, removed: result });
  }
  await deleteInviteRequest(id);
  await audit(guard.email, 'invite.remove', { type: 'invite', id, label: id });
  return NextResponse.json({ ok: true });
}
