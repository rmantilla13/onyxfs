import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import {
  getPersonById, personDetail, updatePerson, removePerson, listAuditEvents,
} from '@/lib/db';
import { getAdminEmails, isSuperAdmin } from '@/lib/auth-allowlist';
import { forgetSession } from '@/lib/session';
import { overrideProblem } from '@/lib/policy';
import { loadRolesAndPolicy, presentPerson, assignableRole, personActionProblem } from '@/lib/people';
import { audit, personSubject } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** The person at /admin/people/[id] — by people.id, so no address is ever in a URL. */
async function loadPerson(id) {
  const person = await getPersonById(id);
  if (!person) return { error: NextResponse.json({ error: 'Person not found' }, { status: 404 }) };
  return { person };
}

/**
 * GET → the drawer: who they are, their role and limits, drives, devices,
 * the links they made, usage, and the last 20 audit events by or about them.
 */
export async function GET(_req, { params }) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  const got = await loadPerson(params.id);
  if (got.error) return got.error;
  let ctx;
  try { ctx = await loadRolesAndPolicy({ fresh: false }); } catch {
    return NextResponse.json({ error: 'Could not read the roles. Try again.' }, { status: 503 });
  }
  const email = got.person.email;
  const [detail, activity] = await Promise.all([
    personDetail(email),
    listAuditEvents({ person: email, limit: 20 }),
  ]);
  const summary = presentPerson({
    person: detail.person || got.person,
    inviteName: detail.inviteName, userName: detail.userName, hasUser: detail.hasUser,
    reviewedBy: detail.reviewedBy, reviewedAt: detail.reviewedAt,
    drives: detail.drives.length, devices: detail.devices.length, bytes: detail.usage.bytes,
    deviceLastUsedAt: Math.max(0, ...detail.devices.map((d) => d.lastUsedAt || 0)) || null,
  }, { ...ctx, adminEmails: getAdminEmails() });
  return NextResponse.json({
    person: summary,
    drives: detail.drives,
    devices: detail.devices.map(({ email: _e, ...d }) => d),
    links: detail.links,
    usage: detail.usage,
    activity,
  });
}

/**
 * PATCH { roleId?, quotaBytes?, maxUploadBytes?, aiMonthlyCents? }
 *
 * roleId: an assignable role, or null for the default. Not for an env admin,
 * whose role is ADMIN_EMAILS. The limits are overrides of the role's value,
 * null to go back to it, and never above the org's ceiling. A per-person AI
 * budget is money, so it takes a super-admin.
 */
export async function PATCH(req, { params }) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  const got = await loadPerson(params.id);
  if (got.error) return got.error;
  const { person } = got;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Bad request' }, { status: 400 });

  let ctx;
  try { ctx = await loadRolesAndPolicy(); } catch {
    return NextResponse.json({ error: 'Could not read the roles and limits, so nothing was changed. Try again.' }, { status: 503 });
  }

  const fields = {};
  if ('roleId' in body) {
    const problem = personActionProblem({ actor: guard.email, target: person.email, action: 'role' });
    if (problem) return NextResponse.json({ error: problem.error }, { status: problem.status });
    if (body.roleId !== null && !assignableRole(ctx.rolesConfig, String(body.roleId))) {
      return NextResponse.json({ error: `"${body.roleId}" is not a role that can be assigned.` }, { status: 400 });
    }
    fields.roleId = body.roleId === null ? null : String(body.roleId);
  }
  for (const key of ['quotaBytes', 'maxUploadBytes', 'aiMonthlyCents']) {
    if (!(key in body)) continue;
    if (key === 'aiMonthlyCents' && !isSuperAdmin(guard.email)) {
      return NextResponse.json({ error: 'Only a super-admin can change an AI budget.' }, { status: 403 });
    }
    const problem = overrideProblem(key, body[key], ctx.policy);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    fields[key] = body[key];
  }
  const unknown = Object.keys(body).filter((k) => !['roleId', 'quotaBytes', 'maxUploadBytes', 'aiMonthlyCents'].includes(k));
  if (unknown.length) return NextResponse.json({ error: `Unknown field: ${unknown.join(', ')}.` }, { status: 400 });
  if (!Object.keys(fields).length) return NextResponse.json({ error: 'Nothing to change.' }, { status: 400 });

  const updated = await updatePerson(person.email, fields);
  // Their next request should see the new role, not the cached one.
  forgetSession(person.email);
  const subject = personSubject(person.email, person.displayName);
  if ('roleId' in fields && fields.roleId !== person.roleId) {
    await audit(guard.email, 'person.role', subject, { from: person.roleId, to: fields.roleId });
  }
  const limitKeys = Object.keys(fields).filter((k) => k !== 'roleId');
  if (limitKeys.length) {
    await audit(guard.email, 'person.limits', subject, Object.fromEntries(limitKeys.map((k) => [k, { from: person[k], to: fields[k] }])));
  }
  return NextResponse.json({ person: presentPerson({ person: updated }, { ...ctx, adminEmails: getAdminEmails() }) });
}

/**
 * DELETE — remove them (lib/db.js removePerson). `?preview=1` answers with
 * what would go, for the confirmation — "3 drive grants, 2 devices and 5
 * links; their 214 files (38 GB) stay" — and changes nothing.
 */
export async function DELETE(req, { params }) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  const got = await loadPerson(params.id);
  if (got.error) return got.error;
  const { email } = got.person;
  const problem = personActionProblem({ actor: guard.email, target: email, action: 'remove' });
  const preview = new URL(req.url).searchParams.get('preview') === '1';
  if (preview) {
    const impact = await removePerson(email);
    return NextResponse.json({ preview: impact, blocked: problem ? problem.error : null });
  }
  if (problem) return NextResponse.json({ error: problem.error }, { status: problem.status });
  const result = await removePerson(email, { apply: true });
  forgetSession(email);
  await audit(guard.email, 'person.remove', personSubject(email, got.person.displayName), result);
  return NextResponse.json({ ok: true, removed: result });
}
