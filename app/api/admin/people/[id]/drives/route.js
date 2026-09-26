import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getPersonById, listFilespacesForUser } from '@/lib/db';
import { isAdmin } from '@/lib/auth-allowlist';
import { parseGrants, applyGrantDiff } from '@/lib/people';
import { audit, personSubject } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * PUT { grants: [{ filespaceId, role }] } — make these the person's drives,
 * applied as a diff: new and changed grants are written, missing ones are
 * revoked, the rest are left alone (and keep who granted them, and when).
 * The platform role's ceiling still applies on top — a Viewer granted
 * editor here is a viewer everywhere.
 */
export async function PUT(req, { params }) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  const person = await getPersonById(params.id);
  if (!person) return NextResponse.json({ error: 'Person not found' }, { status: 404 });
  if (isAdmin(person.email)) {
    return NextResponse.json({ error: 'This person is an admin. Admins already reach every drive.' }, { status: 400 });
  }
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const parsed = await parseGrants(body?.grants);
  if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const current = (await listFilespacesForUser(person.email)).map((f) => ({ filespaceId: f.id, role: f.role }));
  const changes = await applyGrantDiff(person.email, current, parsed.grants, guard.email);
  if (changes.granted.length || changes.revoked.length) {
    await audit(guard.email, 'drive.grant', personSubject(person.email, person.displayName), changes);
  }
  const drives = (await listFilespacesForUser(person.email)).map((f) => ({ filespaceId: f.id, name: f.name, role: f.role }));
  return NextResponse.json({ drives, ...changes });
}
