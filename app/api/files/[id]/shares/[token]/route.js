import { NextResponse } from 'next/server';
import { getFileById, canModifyFile, getShareTarget, deleteShare } from '@/lib/db';
import { requirePrincipal, can, refusal } from '@/lib/authz';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DELETE /api/files/[id]/shares/[token] — revoke a link. Takes effect on the
 * next request to it: the public page and the download both look the row up
 * every time, so there is nothing cached to outlive the revoke.
 *
 * Whoever made the link can always revoke it, and so can anyone who can
 * change the file — whatever their role's link capabilities, and with the
 * `shares` flag off too. Revoking only narrows exposure; a creator whose role
 * lost sharing used to be left unable to take their own public link down.
 *
 * The token must belong to this file, so a link cannot be revoked through a
 * file the caller does happen to be able to edit.
 */
export async function DELETE(_req, { params }) {
  const g = await requirePrincipal();
  if (g.error) return g.error;

  const target = await getShareTarget(params.token);
  if (!target || target.kind !== 'file' || target.fileId !== params.id) {
    return NextResponse.json({ error: 'Link not found' }, { status: 404 });
  }
  const file = await getFileById(params.id);
  const canModify = file ? await canModifyFile(file, g.principal, { action: null }) : false;
  const allowed = can(g.principal, 'shares.revoke', { createdBy: target.createdBy, canModify });
  if (!allowed.ok) return refusal(allowed);

  await deleteShare(params.token);
  await audit(g.email, 'share.revoke', { type: 'file', id: params.id, label: file?.name || params.id }, { token: params.token.slice(0, 6) });
  return NextResponse.json({ ok: true });
}
