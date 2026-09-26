import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getPersonById, setPersonStatus } from '@/lib/db';
import { forgetSession } from '@/lib/session';
import { audit, personSubject } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * POST — undo a suspension. They can sign in again, and their paused links
 * serve again. Their old sessions and devices stay ended: they sign in, and
 * pair their devices, afresh.
 */
export async function POST(_req, { params }) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  const person = await getPersonById(params.id);
  if (!person) return NextResponse.json({ error: 'Person not found' }, { status: 404 });
  if (person.status !== 'suspended') return NextResponse.json({ ok: true, status: person.status });
  await setPersonStatus(person.email, { status: 'active', by: guard.email });
  forgetSession(person.email);
  await audit(guard.email, 'person.reactivate', personSubject(person.email, person.displayName));
  return NextResponse.json({ ok: true, status: 'active' });
}
