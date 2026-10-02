import { NextResponse } from 'next/server';
import { runServerPreviews } from '@/lib/server-previews';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Drawing a big picture takes a while; the run stops claiming well before this.
export const maxDuration = 300;

/**
 * Every minute: the server draws the previews no browser or Mac has (lib/
 * server-previews.js) — images still without a thumbnail two minutes after
 * they were added. A run claims a file at a time and stops taking new ones
 * after four minutes, so runs that overlap share the work (SKIP LOCKED) and
 * none outlives maxDuration.
 *
 * Bearer-authed with CRON_SECRET, as the maintenance cron; the middleware
 * excludes /api/cron.
 */
export async function GET(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(await runServerPreviews({ budgetMs: 240_000, concurrency: 2 }));
}
