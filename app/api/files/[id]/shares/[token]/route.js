import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getFileById, buildPrincipal, canModifyFile, getShareTarget, deleteShare } from '@/lib/db';
import { flagsForUser } from '@/lib/user-flags';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DELETE /api/files/[id]/shares/[token] — revoke a link. Takes effect on the
 * next request to it: the public page and the download both look the row up
 * every time, so there is nothing cached to outlive the revoke.
 *
 * Same gate as creating one. The token must belong to this file, so a link
 * cannot be revoked through a file the caller does happen to be able to edit.
 */
export async function DELETE(_req, { params }) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const { flags } = await flagsForUser(email);
  if (!flags.shares) return NextResponse.json({ error: 'Sharing is turned off for your role.' }, { status: 403 });

  const target = await getShareTarget(params.token);
  if (!target || target.kind !== 'file' || target.fileId !== params.id) {
    return NextResponse.json({ error: 'Link not found' }, { status: 404 });
  }
  const file = await getFileById(params.id);
  const principal = await buildPrincipal(email);
  if (!file || !(await canModifyFile(file, principal))) {
    return NextResponse.json({ error: 'You can view this file but not change its links.' }, { status: 403 });
  }
  await deleteShare(params.token);
  return NextResponse.json({ ok: true });
}
