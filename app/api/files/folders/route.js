import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { listFileFoldersForUser, buildPrincipal, getFilespaceForUser } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET /api/files/folders?filespace= → { folders }
 *
 * The sidebar tree on its own. It counts every file in scope and runs to a
 * couple of hundred kilobytes at 100k files, so the library loads it once per
 * filespace and again only after something changes a folder's contents —
 * rather than with every filter change and search keystroke.
 */
export async function GET(req) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const filespaceId = new URL(req.url).searchParams.get('filespace');
  const fs = filespaceId ? await getFilespaceForUser(session.user.email, filespaceId) : null;
  const storagePrefix = fs ? String(fs.prefix || '').replace(/^\/+|\/+$/g, '') : undefined;
  const principal = await buildPrincipal(session.user.email);
  const folders = await listFileFoldersForUser(principal, { storagePrefix, filespace: storagePrefix });
  return NextResponse.json({ folders });
}
