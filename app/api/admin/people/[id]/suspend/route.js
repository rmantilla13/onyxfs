import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getPersonById, setPersonStatus } from '@/lib/db';
import { forgetSession } from '@/lib/session';
import { personActionProblem } from '@/lib/people';
import { audit, personSubject } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * POST { reason?, pauseLinks? = true } — suspend someone. Reversible: it
 * blocks sign-in, ends their web sessions (on their next request, within 30
 * seconds anywhere) and deletes their desktop tokens, and keeps their drive
 * grants and files. With pauseLinks, the links they made stop serving until
 * they are reactivated ("This link is paused").
 */
export async function POST(req, { params }) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  const person = await getPersonById(params.id);
  if (!person) return NextResponse.json({ error: 'Person not found' }, { status: 404 });
  const problem = personActionProblem({ actor: guard.email, target: person.email, action: 'suspend' });
  if (problem) return NextResponse.json({ error: problem.error }, { status: problem.status });
  let body = {};
  try { body = await req.json(); } catch { /* no reason given */ }
  const reason = body?.reason == null ? null : String(body.reason).trim().slice(0, 500) || null;
  const pauseLinks = body?.pauseLinks !== false;

  const { person: updated, devices } = await setPersonStatus(person.email, { status: 'suspended', reason, by: guard.email, pauseLinks });
  forgetSession(person.email);
  await audit(guard.email, 'person.suspend', personSubject(person.email, person.displayName), { reason, pauseLinks, devices });
  return NextResponse.json({ ok: true, status: updated?.status || 'suspended', devicesSignedOut: devices });
}
