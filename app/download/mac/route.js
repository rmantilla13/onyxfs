import { NextResponse } from 'next/server';
import { latestMacRelease } from '@/lib/mac-release';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /download/mac → the latest Onyx.dmg, or the download page when there is none yet. */
export async function GET(req) {
  const release = await latestMacRelease();
  const target = release?.dmgUrl || release?.zipUrl;
  return NextResponse.redirect(target || new URL('/download', req.nextUrl.origin), 302);
}
