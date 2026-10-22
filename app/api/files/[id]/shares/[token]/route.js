import { NextResponse } from 'next/server';
import {
  getFileById, canModifyFile, getShareTarget, deleteShare, setShareReview, listSharesForFile, refreshReviewStatus,
  updateShareSettings,
} from '@/lib/db';
import { requirePrincipal, can, refusal, shareKindsForKey } from '@/lib/authz';
import { parseShareReview, parseShareChanges, shareKind } from '@/lib/share-kinds';
import { presentFileShare, linkLevelDecision, linkSettingsDecision, settingsAudit } from '@/lib/share-guard';
import { effectiveKind } from '@/lib/media';
import { isReviewableKind } from '@/lib/review';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LEVEL = { comment: 1, approve: 2 };
const rank = (review) => LEVEL[review] || 0;

/**
 * PATCH /api/files/[id]/shares/[token] { review?: 'view' | 'comment' | 'approve',
 * expires?, expiresAt?, downloads?, look? } → { share }
 *
 * Change what a link's recipients may do, when it expires, whether they may
 * download, and how its page looks — each only when the body names it —
 * without a new link to send.
 *
 * Opening it up — comments where there were none, approvals where there were
 * only comments — is making a review link, and takes everything making that
 * link would: the link kind's capability and the drive allowing it, then the
 * review link's own checks, all against the link's remaining lifetime.
 * Closing it down only narrows exposure, so it takes what revoking takes: the
 * link's creator, or anyone who can change the file. Comments already written
 * stay on the file either way. The rule is lib/share-guard.js
 * linkLevelDecision, which the file's list also offers the levels by.
 *
 * Both methods here take the browser's session or the iPhone's device token
 * (requirePrincipal(req)), and hold either to the same rules after it.
 */
export async function PATCH(req, { params }) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }

  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Bad request' }, { status: 400 });

  const target = await getShareTarget(params.token);
  if (!target || target.kind !== 'file' || target.fileId !== params.id) {
    return NextResponse.json({ error: 'Link not found' }, { status: 404 });
  }
  const file = await getFileById(params.id);
  if (!file || file.deletedAt) return NextResponse.json({ error: 'File not found' }, { status: 404 });
  const kind = shareKind({ mode: target.mode, hasPassword: target.hasPassword });
  const asksLevel = body.review !== undefined;
  const parsed = asksLevel ? parseShareReview(body.review, kind) : { review: target.review || null };
  if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { changes, error } = parseShareChanges(body, { target: 'file' });
  if (error) return NextResponse.json({ error }, { status: 400 });
  if (kind === 'private' && changes.downloads === false) {
    return NextResponse.json({ error: 'Private links open only for members, who can already download the file.' }, { status: 400 });
  }
  const canModify = await canModifyFile(file, g.principal, { action: null });

  // The link as it will be, for the level's decision: a later expiry asked
  // for in the same request is the lifetime comments are opened for.
  const after = changes.expiresAt !== undefined ? { ...target, expiresAt: changes.expiresAt } : target;
  const ctx = {
    canModify,
    // The drives the file is in, which only opening a link up is held to.
    driveShareKinds: null,
    reviewable: isReviewableKind(effectiveKind(file)),
  };
  if (rank(parsed.review) > rank(target.review) || Object.keys(changes).length) {
    ctx.driveShareKinds = await shareKindsForKey(g.principal, file.storageKey);
  }
  if (asksLevel) {
    const allowed = linkLevelDecision(g.principal, after, parsed.review, ctx);
    if (!allowed.ok) return refusal(allowed);
  }
  if (Object.keys(changes).length) {
    const allowed = linkSettingsDecision(g.principal, target, changes, ctx);
    if (!allowed.ok) return refusal(allowed);
  }

  if (Object.keys(changes).length) {
    const updated = await updateShareSettings(params.token, changes);
    if (!updated) return NextResponse.json({ error: 'Link not found' }, { status: 404 });
    await audit(g.email, 'share.update', { type: 'file', id: file.id, label: file.name }, {
      token: params.token.slice(0, 6), ...settingsAudit(target, changes),
    });
  }
  if (asksLevel) {
    const stored = await setShareReview(params.token, parsed.review);
    if (stored === undefined) return NextResponse.json({ error: 'Link not found' }, { status: 404 });
    if ((stored || null) !== (target.review || null)) {
      await refreshReviewStatus(file.id).catch(() => {});
      await audit(g.email, 'share.update', { type: 'file', id: file.id, label: file.name }, {
        token: params.token.slice(0, 6), review: stored || 'view', was: target.review || 'view',
      });
    }
  }
  const share = (await listSharesForFile(file.id)).find((s) => s.token === params.token);
  if (!share) return NextResponse.json({ share: null });
  // The levels it may go to from here: the drives are read now if they were not.
  if (ctx.driveShareKinds == null) ctx.driveShareKinds = await shareKindsForKey(g.principal, file.storageKey);
  return NextResponse.json({ share: presentFileShare(g.principal, share, ctx) });
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
export async function DELETE(req, { params }) {
  const g = await requirePrincipal(req);
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
