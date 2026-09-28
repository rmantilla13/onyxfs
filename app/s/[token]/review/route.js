import { NextResponse } from 'next/server';
import { listReviewFeed, getReviewRead, markReviewRead } from '@/lib/db';
import { openGuestReview, guestJson } from '@/lib/share-review';
import { commentForGuest, decisionForGuest, guestReviewer } from '@/lib/review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /s/<token>/review?after=<seq>
 *
 * A review link's comments, for the people it reaches: the member feed's
 * shape (GET /api/files/[id]/review), so the same panel reads both, holding
 * only what this link may see — no internal comment, nothing from another
 * link's guests, none of the team's decisions (listReviewFeed with the
 * token) — and, of that, no address anywhere (commentForGuest). Nor the
 * file's status and open count: those are counted over everything.
 *
 * Decided again on every poll (openGuestReview), so a link revoked, expired
 * or turned back to view-only stops answering on the next one. The unchanged
 * case is a 304, as for members. A guest who has given a name has a read
 * marker, for the unread dots, like a member.
 */
export async function GET(req, { params }) {
  const g = await openGuestReview(params.token, 'read');
  if (g.error) return g.error;

  const after = Math.max(0, Math.floor(Number(new URL(req.url).searchParams.get('after')) || 0));
  const subject = g.guest ? guestReviewer(g.guest.id) : null;
  const readSeq = after === 0 && subject ? await getReviewRead(subject, g.file.id) : null;
  const feed = await listReviewFeed(g.file.id, { after, shareToken: g.token });
  const etag = `W/"${g.file.id}.link.${feed.cursor}"`;

  if (after > 0 && !feed.comments.length && !feed.decisions.length) {
    return new NextResponse(null, { status: 304, headers: { etag, 'cache-control': 'private, no-cache' } });
  }
  if (subject) await markReviewRead(subject, g.file.id, feed.cursor);

  const res = guestJson({
    comments: feed.comments.map(commentForGuest),
    decisions: feed.decisions.map(decisionForGuest),
    cursor: feed.cursor,
    more: feed.more,
    readSeq,
  }, 200);
  res.headers.set('etag', etag);
  res.headers.set('cache-control', 'private, no-cache');
  return res;
}
