import { NextResponse } from 'next/server';
import { requireDesktopAuth } from '@/lib/desktop-guard';
import { revokeDesktopToken, getPersonByEmail } from '@/lib/db';
import { forgetSession } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET — bearer canary. The desktop calls this on launch to validate its token.
 * → { email, isAdmin, name }: `name` is the account's own display name (the
 * one its people row carries), for the iPhone's greeting; null when none is
 * set, or when it cannot be read — a greeting is never a reason to fail.
 */
export async function GET(req) {
  const gate = await requireDesktopAuth(req);
  if (gate.error) return gate.error;
  const person = await getPersonByEmail(gate.email).catch(() => null);
  return NextResponse.json({ email: gate.email, isAdmin: gate.isAdmin, name: person?.displayName || null });
}

/**
 * DELETE — server-side logout: revoke the calling token. The web view the
 * app signed in with this token goes with it (lib/session.js checks the
 * device behind a web session): at once on this instance, within 30 seconds
 * on any other.
 */
export async function DELETE(req) {
  const gate = await requireDesktopAuth(req);
  if (gate.error) return gate.error;
  await revokeDesktopToken(gate.tokenId);
  forgetSession(gate.email);
  return NextResponse.json({ ok: true });
}
