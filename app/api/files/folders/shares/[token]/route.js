import { NextResponse } from 'next/server';
import { getShareTarget, deleteShare } from '@/lib/db';
import { requirePrincipal, can, refusal } from '@/lib/authz';
import { isShareToken } from '@/lib/share-kinds';
import { folderLinkWritable, folderLinkSubject } from '@/lib/share-guard';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DELETE /api/files/folders/shares/[token] — revoke a link to a folder.
 * Takes effect on the next request to it: the page, its listing, its
 * previews and downloads all look the row up every time, so nothing cached
 * outlives the revoke (a signed URL already handed out lasts its few hours,
 * as a file link's does).
 *
 * Whoever made the link can always revoke it, and so can anyone who may
 * manage the folder's links (lib/share-guard.js folderLinkWritable: the
 * drive's editors and owners, or an editor or owner folder grant in the
 * library) and admins — whatever their role's link capabilities, and with
 * the `shares` flag off too. Revoking only narrows exposure.
 *
 * The token is all the request names: which folder, and in which scope, is
 * the link's own, so it cannot be revoked by way of some other folder the
 * caller does happen to manage. A token that is not a folder link is not
 * found here — a file's links are revoked through the file.
 *
 * The browser's session or the iPhone's device token (requirePrincipal(req)),
 * held to the same rules after it.
 */
export async function DELETE(req, { params }) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const token = params?.token;
  if (!isShareToken(token)) return NextResponse.json({ error: 'Link not found' }, { status: 404 });

  const target = await getShareTarget(token);
  if (!target || target.kind !== 'folder') return NextResponse.json({ error: 'Link not found' }, { status: 404 });
  const canModify = await folderLinkWritable(g.principal, target);
  const allowed = can(g.principal, 'shares.revoke', { createdBy: target.createdBy, canModify });
  if (!allowed.ok) return refusal(allowed);

  await deleteShare(token);
  await audit(g.email, 'share.revoke', folderLinkSubject({ storagePrefix: target.storagePrefix, folder: target.folder }), {
    token: token.slice(0, 6),
  });
  return NextResponse.json({ ok: true });
}
