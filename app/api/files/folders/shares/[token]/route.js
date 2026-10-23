import { NextResponse } from 'next/server';
import { getShareTarget, deleteShare, updateShareSettings, listSharesForFolder } from '@/lib/db';
import { requirePrincipal, can, refusal } from '@/lib/authz';
import { isShareToken, parseShareChanges } from '@/lib/share-kinds';
import {
  folderLinkWritable, folderLinkSubject, folderShareKinds, linkSettingsDecision, settingsAudit, presentShare,
} from '@/lib/share-guard';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/files/folders/shares/[token] { expires?, expiresAt?, downloads?, look? }
 * → { share } — change when a folder's link expires, whether its people may
 * download, and how its page looks, each only when the body names it.
 *
 * Who may, as for revoking (folderLinkWritable): its maker, anyone who may
 * manage the folder's links, admins. Opening it up — a later expiry, or
 * downloads back on — is making the link again and takes what that takes,
 * against the lifetime it will have (lib/share-guard.js linkSettingsDecision);
 * the rest only narrows or restyles it.
 */
export async function PATCH(req, { params }) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const token = params?.token;
  if (!isShareToken(token)) return NextResponse.json({ error: 'Link not found' }, { status: 404 });
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  if (body.review !== undefined && body.review !== 'view' && body.review !== null) {
    return NextResponse.json({ error: 'Links to folders cannot take comments. Share a photo or a video for review.' }, { status: 400 });
  }

  const target = await getShareTarget(token);
  if (!target || target.kind !== 'folder') return NextResponse.json({ error: 'Link not found' }, { status: 404 });
  const { changes, error } = parseShareChanges(body, { target: 'folder' });
  if (error) return NextResponse.json({ error }, { status: 400 });
  const canModify = await folderLinkWritable(g.principal, target);
  if (Object.keys(changes).length) {
    const driveShareKinds = await folderShareKinds(g.principal, { storagePrefix: target.storagePrefix, name: target.folder });
    const allowed = linkSettingsDecision(g.principal, target, changes, { canModify, driveShareKinds });
    if (!allowed.ok) return refusal(allowed);
    const updated = await updateShareSettings(token, changes);
    if (!updated) return NextResponse.json({ error: 'Link not found' }, { status: 404 });
    await audit(g.email, 'share.update', folderLinkSubject({ storagePrefix: target.storagePrefix, folder: target.folder }), {
      token: token.slice(0, 6), ...settingsAudit(target, changes),
    });
  } else {
    // Nothing to change: still only for someone who could have.
    const allowed = can(g.principal, 'shares.revoke', { createdBy: target.createdBy, canModify });
    if (!allowed.ok) return refusal(allowed);
  }
  const share = (await listSharesForFolder(target.folder, target.storagePrefix)).find((s) => s.token === token);
  return NextResponse.json({ share: share ? presentShare(share) : null });
}

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
