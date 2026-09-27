import { createReviewComment, refreshReviewStatus, addReviewWatchers } from '@/lib/db';
import { openGuestReview, loadForGuest, overLimit, guestJson } from '@/lib/share-review';
import { validateComment, commentForGuest, guestReviewer } from '@/lib/review';
import { notifyReviewComment } from '@/lib/review-notify';
import { toRate, frameCount } from '@/lib/video-time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /s/<token>/comments
 *   { body, anchor, frameIn, frameOut, fps, pointX, pointY, annotation, parentId }
 *
 * A guest's comment or reply, through a review link: the same comment a
 * member writes (validateComment — frames, ranges, pins, drawings), except
 * that it is for everyone and names nobody. A guest cannot write an internal
 * comment, and cannot mention anyone: a mention is a notification sent, and
 * a link may be held by anyone. A reply goes only on a thread this link may
 * see (loadForGuest), and joins it at its top.
 *
 * The file's uploader and whoever made the link follow its review from
 * here, so they hear of it; so does everyone already following it.
 */
export async function POST(req, { params }) {
  const g = await openGuestReview(params.token, 'comment');
  if (g.error) return g.error;
  let body;
  try { body = await req.json(); } catch { return guestJson({ error: 'Bad request' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return guestJson({ error: 'Bad request' }, 400);

  const slow = await overLimit(g);
  if (slow) return guestJson({ error: slow }, 429);

  let parent = null;
  if (body.parentId != null) {
    const found = await loadForGuest(g, body.parentId);
    if (found.error) return guestJson({ error: 'That comment is no longer there to reply to.' }, 400);
    parent = found.comment;
  }

  const md = g.file.metadata || {};
  const rate = toRate(md.fps);
  const checked = validateComment({ ...body, audience: 'all', mentions: [] }, {
    kind: g.kind,
    rate,
    totalFrames: rate ? frameCount({ frames: md.frames, duration: md.duration, fps: rate }) : Infinity,
    isReply: !!parent,
  });
  if (checked.error) return guestJson({ error: checked.error }, 400);
  const value = { ...checked.value, audience: 'all', mentions: [] };
  if (parent) value.parentId = parent.parentId || parent.id;

  const comment = await createReviewComment({
    fileId: g.file.id,
    authorName: g.guest.name,
    guestId: g.guest.id,
    shareToken: g.token,
    value,
  });
  await refreshReviewStatus(g.file.id);
  await addReviewWatchers(g.file.id, [g.file.createdBy, g.row?.created_by]).catch(() => {});
  await notifyReviewComment({ file: g.file, comment, parent, actor: guestReviewer(g.guest.id) });

  return guestJson({ comment: commentForGuest(comment) }, 201);
}
