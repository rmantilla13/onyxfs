import { NextResponse } from 'next/server';
import { latestMacRelease } from '@/lib/mac-release';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/desktop/mac/latest → the newest Mac release (lib/mac-release.js),
 * or 404 when there is none. Public: the app asks before anyone is signed in,
 * and a release is published for anyone to download anyway.
 */
export async function GET() {
  const release = await latestMacRelease();
  if (!release) return NextResponse.json({ error: 'No Mac release has been published yet.' }, { status: 404 });
  return NextResponse.json(release, { headers: { 'cache-control': 'public, max-age=300' } });
}
