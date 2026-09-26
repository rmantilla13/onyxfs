import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getPersonById, signOutEverywhere } from '@/lib/db';
import { forgetSession } from '@/lib/session';
import { audit, personSubject } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * POST — end every session this person has: each browser signed in before
 * now is signed out on its next request (within 30 seconds on any other
 * instance), and every desktop token is revoked. They can sign straight
 * back in; this is for a lost laptop, not a ban — that is Suspend.
 */
export async function POST(_req, { params }) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  const person = await getPersonById(params.id);
  if (!person) return NextResponse.json({ error: 'Person not found' }, { status: 404 });
  const { devices } = await signOutEverywhere(person.email);
  forgetSession(person.email);
  await audit(guard.email, 'person.signout', personSubject(person.email, person.displayName), { devices });
  return NextResponse.json({ ok: true, devicesSignedOut: devices });
}
