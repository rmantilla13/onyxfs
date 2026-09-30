import { NextResponse } from 'next/server';
import { getFileById, canModifyFile, createShare, listSharesForFile, refreshReviewStatus } from '@/lib/db';
import { requirePrincipal, can, refusal, shareCapFor, shareKindsForKey } from '@/lib/authz';
import { parseShareRequest } from '@/lib/share-kinds';
import { presentFileShare, reviewLinkRefusal, linkChoices } from '@/lib/share-guard';
import { effectiveKind } from '@/lib/media';
import { isReviewableKind } from '@/lib/review';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Who may see and revoke a file's links: someone signed in with WRITE access
 * to the file (or an admin). Write rather than read, because a public link
 * takes a file outside the workspace — which is not something everyone who
 * can see it should be able to do.
 *
 * Deliberately not gated on the role's link capabilities or the `shares`
 * flag: this list is how links are revoked, and revoking only narrows
 * exposure. Making a link checks those, per kind, in POST.
 *
 * Signed in is the browser's session or the iPhone's device token
 * (requirePrincipal(req)): the same principal either way, and a token only
 * for a role that may use the apps (desktop.mount). Everything after it is
 * the same for both.
 */
async function gate(req, id) {
  const g = await requirePrincipal(req);
  if (g.error) return g;
  const file = await getFileById(id);
  if (!file || file.deletedAt) return { error: NextResponse.json({ error: 'File not found' }, { status: 404 }) };
  const canModify = await canModifyFile(file, g.principal, { action: null });
  if (!canModify) {
    return { error: NextResponse.json({ error: 'You can view this file but not share it.' }, { status: 403 }) };
  }
  return { ...g, file, canModify };
}

/** What the decisions about this file's links rest on, besides who is asking. */
const linkContext = (g, driveShareKinds) => ({
  canModify: g.canModify,
  driveShareKinds,
  reviewable: isReviewableKind(effectiveKind(g.file)),
});

/**
 * GET /api/files/[id]/shares → { shares, can } — the file's links, newest
 * first, and what this person may make (lib/share-guard.js linkChoices: the
 * kinds, review levels and expiries POST would accept, and why not when it
 * would accept none). Each link says where it opens (`path`, on this
 * server) and the levels this person may set it to (`levels`; PATCH on the
 * link decides with the same rule).
 */
export async function GET(req, { params }) {
  const g = await gate(req, params.id);
  if (g.error) return g.error;
  const ctx = linkContext(g, await shareKindsForKey(g.principal, g.file.storageKey));
  const shares = await listSharesForFile(g.file.id);
  return NextResponse.json({
    shares: shares.map((s) => presentFileShare(g.principal, s, ctx)),
    can: linkChoices(g.principal, ctx),
  });
}

/**
 * POST /api/files/[id]/shares { kind: 'public'|'password'|'private',
 * password?, expires: 'never'|'1'|'7'|'30', review?: 'view'|'comment'|'approve' }
 * → { share }.
 *
 * Each kind is its own capability — a private link stays inside the
 * workspace, a public or password one does not — and each is held to the
 * `shares` flag (read here, never taken from the client), the link kinds the
 * file's drive allows, and the longest expiry the role allows. A link that
 * takes comments is a review link, and is held to all of that again as one
 * (reviewLinkRefusal).
 */
export async function POST(req, { params }) {
  const g = await gate(req, params.id);
  if (g.error) return g.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const parsed = parseShareRequest(body);
  if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const kind = parsed.password ? 'password' : parsed.mode;
  const driveShareKinds = await shareKindsForKey(g.principal, g.file.storageKey);
  const allowed = can(g.principal, shareCapFor(kind), {
    canModify: g.canModify,
    kind,
    driveShareKinds,
    expiresInDays: parsed.expiresInDays,
  });
  if (!allowed.ok) return refusal(allowed);
  if (parsed.review) {
    const no = await reviewLinkRefusal(g, g.file, { kind, expiresInDays: parsed.expiresInDays });
    if (no) return no;
  }

  const { token, reused } = await createShare({
    fileId: g.file.id,
    createdBy: g.email,
    mode: parsed.mode,
    password: parsed.password,
    expiresInDays: parsed.expiresInDays,
    review: parsed.review,
  });
  if (!reused) {
    await audit(g.email, 'share.create', { type: 'file', id: g.file.id, label: g.file.name }, {
      kind, expiresInDays: parsed.expiresInDays, ...(parsed.review ? { review: parsed.review } : {}),
    });
    // A link that takes comments puts the file in review.
    if (parsed.review) await refreshReviewStatus(g.file.id).catch(() => {});
  }
  const share = (await listSharesForFile(g.file.id)).find((s) => s.token === token);
  return NextResponse.json({ share: presentFileShare(g.principal, share, linkContext(g, driveShareKinds)) });
}
