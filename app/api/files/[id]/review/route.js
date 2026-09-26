import { NextResponse } from 'next/server';
import {
  listReviewFeed, refreshReviewStatus, getReviewRead, markReviewRead, displayNamesFor,
} from '@/lib/db';
import { openReview, reviewJson } from '@/lib/review-guard';
import { userReviewer } from '@/lib/review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/files/[id]/review?after=<seq>
 *
 * A file's review since the cursor: the comments and decisions written or
 * changed after `after`, the file's status and open count, and the new
 * cursor. An open review panel polls this every few seconds while it is
 * visible, so the unchanged case is the common one and answers 304 with no
 * body — one indexed range read (review_comments by file and seq) and nothing
 * else once the request is authorized.
 *
 * Authorized on every poll, not once per page load: a person removed from a
 * drive stops receiving its comments on their next poll, not their next visit.
 *
 * The first load (`after` absent or 0) also says how far this person had read
 * (`readSeq`), for the unread dots; every delivery moves their marker on.
 */
export async function GET(req, { params }) {
  const g = await openReview(params.id, 'read');
  if (g.error) return g.error;

  const after = Math.max(0, Math.floor(Number(new URL(req.url).searchParams.get('after')) || 0));
  const subject = userReviewer(g.email);
  const readSeq = after === 0 ? await getReviewRead(subject, g.file.id) : null;
  const feed = await listReviewFeed(g.file.id, { after });
  const etag = `W/"${g.file.id}.${feed.cursor}"`;

  if (after > 0 && !feed.comments.length && !feed.decisions.length) {
    return new NextResponse(null, { status: 304, headers: { etag, 'cache-control': 'private, no-cache' } });
  }

  // Counted now rather than read off the file row: two writers racing can
  // leave the row a step behind, and this is where it catches up.
  const summary = await refreshReviewStatus(g.file.id, { status: g.file.reviewStatus, openComments: g.file.openComments });
  const names = await displayNamesFor(feed.decisions.map((d) => d.email).filter(Boolean));
  await markReviewRead(subject, g.file.id, feed.cursor);

  const res = reviewJson({
    comments: feed.comments,
    decisions: feed.decisions.map((d) => ({ ...d, name: d.email ? names.get(d.email) || null : null })),
    cursor: feed.cursor,
    more: feed.more,
    status: summary.status,
    openComments: summary.openComments,
    readSeq,
  }, 200);
  res.headers.set('etag', etag);
  res.headers.set('cache-control', 'private, no-cache');
  return res;
}
