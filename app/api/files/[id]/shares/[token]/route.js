import { NextResponse } from 'next/server';
import {
  getFileById, canModifyFile, getShareTarget, deleteShare, setShareReview, listSharesForFile, refreshReviewStatus,
} from '@/lib/db';
import { requirePrincipal, can, refusal, shareCapFor, shareKindsForKey } from '@/lib/authz';
import { parseShareReview, shareKind } from '@/lib/share-kinds';
import { presentShare, reviewLinkRefusal } from '@/lib/share-guard';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LEVEL = { comment: 1, approve: 2 };
const rank = (review) => LEVEL[review] || 0;

/**
 * PATCH /api/files/[id]/shares/[token] { review: 'view' | 'comment' | 'approve' } → { share }
 *
 * Change what a link's recipients may do, without a new link to send.
 *
 * Opening it up — comments where there were none, approvals where there were
 * only comments — is making a review link, and takes everything making that
 * link would: the link kind's capability and the drive allowing it, then the
 * review link's own checks (reviewLinkRefusal), all against the link's
 * remaining lifetime. Closing it down only narrows exposure, so it takes what
 * revoking takes: the link's creator, or anyone who can change the file.
 * Comments already written stay on the file either way.
 */
export async function PATCH(req, { params }) {
  const g = await requirePrincipal();
  if (g.error) return g.error;
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }

  const target = await getShareTarget(params.token);
  if (!target || target.kind !== 'file' || target.fileId !== params.id) {
    return NextResponse.json({ error: 'Link not found' }, { status: 404 });
  }
  const file = await getFileById(params.id);
  if (!file || file.deletedAt) return NextResponse.json({ error: 'File not found' }, { status: 404 });
  const kind = shareKind({ mode: target.mode, hasPassword: target.hasPassword });
  const parsed = parseShareReview(body?.review, kind);
  if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const canModify = await canModifyFile(file, g.principal, { action: null });

  if (rank(parsed.review) > rank(target.review)) {
    const left = target.expiresAt == null ? null : target.expiresAt - Date.now();
    if (left != null && left <= 0) return NextResponse.json({ error: 'This link has expired. Make a new one.' }, { status: 400 });
    const expiresInDays = left == null ? null : Math.ceil(left / 86400000);
    const allowed = can(g.principal, shareCapFor(kind), {
      canModify,
      kind,
      driveShareKinds: await shareKindsForKey(g.principal, file.storageKey),
      expiresInDays,
    });
    if (!allowed.ok) return refusal(allowed);
    const no = await reviewLinkRefusal({ principal: g.principal, canModify }, file, { kind, expiresInDays });
    if (no) return no;
  } else {
    const allowed = can(g.principal, 'shares.revoke', { createdBy: target.createdBy, canModify });
    if (!allowed.ok) return refusal(allowed);
  }

  const stored = await setShareReview(params.token, parsed.review);
  if (stored === undefined) return NextResponse.json({ error: 'Link not found' }, { status: 404 });
  if ((stored || null) !== (target.review || null)) {
    await refreshReviewStatus(file.id).catch(() => {});
    await audit(g.email, 'share.update', { type: 'file', id: file.id, label: file.name }, {
      token: params.token.slice(0, 6), review: stored || 'view', was: target.review || 'view',
    });
  }
  const share = (await listSharesForFile(file.id)).find((s) => s.token === params.token);
  return NextResponse.json({ share: share ? presentShare(share) : null });
}

/**
 * DELETE /api/files/[id]/shares/[token] — revoke a link. Takes effect on the
 * next request to it: the public page and the download both look the row up
 * every time, so there is nothing cached to outlive the revoke. A review
 * link's guests stop being able to read or write on their next poll; what
 * they wrote stays on the file.
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
  // The file was in review for that link's sake; it may not be now.
  if (target.review && file) await refreshReviewStatus(file.id).catch(() => {});
  return NextResponse.json({ ok: true });
}
