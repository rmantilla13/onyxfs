import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { isAdmin } from '@/lib/auth-allowlist';
import { listFilespacesForSpace, countFilesUnderPrefix, libraryUsage } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET → { usage: { [driveId]: { files, bytes } }, library: { files, bytes } | null }
 *
 * What the drive list shows under each drive. Asked for after the page is on
 * screen rather than while it renders: these are sums over every file in a
 * drive, and the directory should never wait for arithmetic about itself.
 * Counted for the people who look after a drive (admins and its owners) —
 * a viewer's total would include files hidden from them — and the library's
 * for admins alone, for the same reason.
 */
export async function GET() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const admin = isAdmin(email);
  const drives = (await listFilespacesForSpace(email)).filter((d) => admin || d.role === 'owner');
  const [rows, library] = await Promise.all([
    Promise.all(drives.map(async (d) => [d.id, await countFilesUnderPrefix(d.prefix).catch(() => null)])),
    admin ? libraryUsage().catch(() => null) : null,
  ]);
  return NextResponse.json(
    { usage: Object.fromEntries(rows.filter(([, u]) => u)), library },
    { headers: { 'cache-control': 'private, max-age=30' } },
  );
}
