import { NextResponse } from 'next/server';
import { requireDesktopAuth } from '@/lib/desktop-guard';
import { revokeDesktopToken } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — bearer canary. The desktop calls this on launch to validate its token. */
export async function GET(req) {
  const gate = await requireDesktopAuth(req);
  if (gate.error) return gate.error;
  return NextResponse.json({ email: gate.email, isAdmin: gate.isAdmin });
}

/** DELETE — server-side logout: revoke the calling token. */
export async function DELETE(req) {
  const gate = await requireDesktopAuth(req);
  if (gate.error) return gate.error;
  await revokeDesktopToken(gate.tokenId);
  return NextResponse.json({ ok: true });
}
