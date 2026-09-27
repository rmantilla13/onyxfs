// lib/share-guard.js — what the routes that make and change a file's links
// (app/api/files/[id]/shares) share: how a link is shown to the people who
// manage it, and the second check a link that takes comments has to pass.
// Node only: it reaches lib/db.js through lib/authz.js.

import { NextResponse } from 'next/server';
import { can, refusal, shareKindsForKey } from '@/lib/authz';
import { shareKind, shareReview } from '@/lib/share-kinds';
import { effectiveKind } from '@/lib/media';
import { isReviewableKind } from '@/lib/review';

/** A link as the share dialog shows it. Never the password or its hash. */
export const presentShare = (s) => ({
  token: s.token,
  kind: shareKind(s),
  review: shareReview(s),
  expiresAt: s.expiresAt,
  viewCount: s.viewCount,
  createdAt: s.createdAt,
  createdBy: s.createdBy,
});

/**
 * May the person behind `g` ({ principal, canModify }) let a link to `file`
 * take comments — and approvals? The link kind's own capability is checked
 * by the caller; this is the one a review link takes on top
 * ('review.links' in lib/authz.js): the `shares` and `review` flags, the
 * capability, the file's drives allowing review links, and the role's
 * longest expiry. Only a photo or a video, and never a private link, whose
 * people comment on the file itself. Null when allowed; else the Response.
 */
export async function reviewLinkRefusal(g, file, { kind, expiresInDays }) {
  if (kind === 'private') {
    return NextResponse.json({ error: 'Private links open only for members, who already comment on the file.' }, { status: 400 });
  }
  if (!isReviewableKind(effectiveKind(file))) {
    return NextResponse.json({ error: 'Only photos and videos can take comments through a link.' }, { status: 400 });
  }
  const allowed = can(g.principal, 'review.links', {
    canModify: g.canModify,
    kind: 'review',
    driveShareKinds: await shareKindsForKey(g.principal, file.storageKey),
    expiresInDays,
  });
  return allowed.ok ? null : refusal(allowed);
}
