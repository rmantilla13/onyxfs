import { NextResponse } from 'next/server';
import { requireDesktopAuth } from '@/lib/desktop-guard';
import { revokeDesktopToken } from '@/lib/db';
import { forgetSession } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — bearer canary. The desktop calls this on launch to validate its token. */
export async function GET(req) {
  const gate = await requireDesktopAuth(req);
  if (gate.error) return gate.error;
  return NextResponse.json({ email: gate.email, isAdmin: gate.isAdmin });
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
