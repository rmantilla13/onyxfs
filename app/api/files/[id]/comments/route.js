import {
  getReviewComment, createReviewComment, refreshReviewStatus, addReviewWatchers, displayNamesFor,
} from '@/lib/db';
import { openReview, peopleWhoCanRead, reviewJson } from '@/lib/review-guard';
import { validateComment } from '@/lib/review';
import { notifyReviewComment } from '@/lib/review-notify';
import { toRate, frameCount } from '@/lib/video-time';

export const runtime = 'nodejs';

/**
 * POST /api/files/[id]/comments
 *   { body, anchor, frameIn, frameOut, fps, pointX, pointY, annotation, parentId, audience, mentions }
 *
 * A comment on a file, or a reply to one. Anyone who may read the file may
 * comment on it (lib/review.js reviewDecision). What it may contain is
 * validateComment's to say; who it may mention is decided here, per address,
 * by whether that person could read the file — anyone else is dropped rather
 * than refused, so the answer does not reveal who exists.
 *
 * A reply is attached to the top of its thread (threads are one level deep),
 * inherits an internal thread's audience, and carries no anchor of its own.
 */
export async function POST(req, { params }) {
  const g = await openReview(params.id, 'comment');
  if (g.error) return g.error;
  let body;
  try { body = await req.json(); } catch { return reviewJson({ error: 'Bad request' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reviewJson({ error: 'Bad request' }, 400);

  let parent = null;
  if (body.parentId != null) {
    parent = await getReviewComment(String(body.parentId));
    if (!parent || parent.fileId !== g.file.id || parent.deletedAt) {
      return reviewJson({ error: 'That comment is no longer there to reply to.' }, 400);
    }
  }

  const md = g.file.metadata || {};
  const rate = toRate(md.fps);
  const checked = validateComment(body, {
    kind: g.kind,
    rate,
    totalFrames: rate ? frameCount({ frames: md.frames, duration: md.duration, fps: rate }) : Infinity,
    isReply: !!parent,
  });
  if (checked.error) return reviewJson({ error: checked.error }, 400);
  const value = checked.value;
  if (parent) {
    value.parentId = parent.parentId || parent.id;
    if (parent.audience === 'internal') value.audience = 'internal';
  }
  value.mentions = await peopleWhoCanRead(g.file, value.mentions.filter((m) => m !== g.email));

  const names = await displayNamesFor([g.email]);
  const comment = await createReviewComment({
    fileId: g.file.id,
    authorEmail: g.email,
    authorName: names.get(g.email) || null,
    value,
  });
  const summary = await refreshReviewStatus(g.file.id);
  // The uploader, whoever writes, and whoever is named now follow the file.
  await addReviewWatchers(g.file.id, [g.file.createdBy, g.email, ...value.mentions]).catch(() => {});
  await notifyReviewComment({ file: g.file, comment, parent, actor: g.email });

  return reviewJson({ comment, status: summary.status, openComments: summary.openComments }, 201);
}
