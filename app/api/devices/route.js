import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { listDesktopTokens, revokeDesktopToken } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The caller's own paired desktop clients.
 *
 * Deliberately not under /api/admin: managing the devices signed in as you is
 * not an administrative act, and gating it on ADMIN_EMAILS would leave every
 * non-admin member unable to revoke their own stolen laptop.
 */

/**
 * GET /api/devices → { devices }.
 *
 * listDesktopTokens selects no token and no hash, which is the point — the raw
 * token is shown exactly once at pairing and only its sha256 is ever stored.
 * Expired rows are included; the client labels them rather than hiding them,
 * since a device you can still see is a device you can still revoke.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  return NextResponse.json({ devices: await listDesktopTokens(session.user.email) });
}

/**
 * DELETE /api/devices?id= — revoke one device.
 *
 * The id is a bare UUID that carries no owner, so being signed in is not
 * authorization here: without the ownership check below, anyone with a session
 * could revoke anyone else's device by guessing an id. An id that is not the
 * caller's gets the same idempotent { ok: true } an already-revoked one does,
 * because answering differently would confirm that some stranger's device
 * exists.
 */
export async function DELETE(req) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const id = String(new URL(req.url).searchParams.get('id') || '').trim();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const own = await listDesktopTokens(session.user.email);
  if (own.some((d) => d.id === id)) await revokeDesktopToken(id);
  return NextResponse.json({ ok: true });
}
