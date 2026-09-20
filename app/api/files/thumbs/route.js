import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { enqueueMissingThumbs, countPendingThumbs } from '@/lib/db';
import { drainThumbs } from '@/lib/thumbs';

export const runtime = 'nodejs';
export const maxDuration = 300; // Hobby allows up to 300s; Pro can go higher
export const dynamic = 'force-dynamic';

// Cron (Vercel sends GET with the CRON_SECRET bearer) vs an interactive kick
// from a signed-in user.
function isCron(req) {
  const a = req.headers.get('authorization');
  return !!process.env.CRON_SECRET && a === `Bearer ${process.env.CRON_SECRET}`;
}
async function isUser() {
  try { const s = await auth(); return !!s?.user?.email; } catch { return false; }
}

// GET — cron drains the queue; a signed-in user just reads the pending count
// (cheap, for the "generating previews" hint). Anyone else: 401.
export async function GET(req) {
  if (isCron(req)) {
    await enqueueMissingThumbs();
    const res = await drainThumbs({});
    return NextResponse.json({ ok: true, ...res, pending: await countPendingThumbs() });
  }
  if (await isUser()) return NextResponse.json({ pending: await countPendingThumbs() });
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

// POST — interactive kick (Space load): enqueue any missing thumbs and drain.
export async function POST(req) {
  if (!(isCron(req) || (await isUser()))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  await enqueueMissingThumbs();
  const res = await drainThumbs({});
  return NextResponse.json({ ok: true, ...res, pending: await countPendingThumbs() });
}
