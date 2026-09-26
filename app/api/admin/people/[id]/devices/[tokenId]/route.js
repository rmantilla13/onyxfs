import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getPersonById, listDesktopTokens, revokeDesktopToken } from '@/lib/db';
import { forgetSession } from '@/lib/session';
import { audit, personSubject } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * DELETE — sign one of this person's devices out. The token must be theirs:
 * a device id taken from one person's drawer cannot revoke another's. The
 * app's next request gets a 401, and so does the web view it signed in
 * (lib/session.js, deviceTokenId).
 */
export async function DELETE(_req, { params }) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  const person = await getPersonById(params.id);
  if (!person) return NextResponse.json({ error: 'Person not found' }, { status: 404 });
  const device = (await listDesktopTokens(person.email)).find((t) => t.id === params.tokenId);
  if (!device) return NextResponse.json({ error: 'Device not found' }, { status: 404 });
  await revokeDesktopToken(device.id);
  forgetSession(person.email);
  await audit(guard.email, 'person.device.revoke', personSubject(person.email, person.displayName), { label: device.label || null });
  return NextResponse.json({ ok: true });
}
