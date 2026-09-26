import {
  getReviewComment, editReviewComment, resolveReviewComment, deleteReviewComment, refreshReviewStatus,
} from '@/lib/db';
import { openReview, refused, peopleWhoCanRead, reviewJson } from '@/lib/review-guard';
import { BODY_MAX, normalizeMentions } from '@/lib/review';

export const runtime = 'nodejs';

/** The comment, if it is on this file and not deleted; else a 404 response. */
async function load(g, cid) {
  const c = await getReviewComment(cid);
  if (!c || c.fileId !== g.file.id || c.deletedAt) return { error: reviewJson({ error: 'Comment not found' }, 404) };
  return { comment: c, isAuthor: !!c.author.email && c.author.email === g.email };
}

/**
 * PATCH /api/files/[id]/comments/[cid]
 *   { body, mentions }   edit the words — the author only; marked "edited"
 *   { resolved: bool }   resolve or reopen a thread — its author, or anyone
 *                        who may change the file
 */
export async function PATCH(req, { params }) {
  const g = await openReview(params.id, 'read', { modify: true });
  if (g.error) return g.error;
  let body;
  try { body = await req.json(); } catch { return reviewJson({ error: 'Bad request' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reviewJson({ error: 'Bad request' }, 400);
  const found = await load(g, params.cid);
  if (found.error) return found.error;
  const { comment, isAuthor } = found;

  if (typeof body.body === 'string') {
    const no = refused(g, 'edit', { isAuthor });
    if (no) return no;
    const text = body.body.replace(/\r\n?/g, '\n').trim();
    if (text.length > BODY_MAX) return reviewJson({ error: `A comment can be up to ${BODY_MAX.toLocaleString('en-US')} characters.` }, 400);
    // A drawing can stand on its own; words alone cannot be emptied away.
    if (!text && !comment.annotation) return reviewJson({ error: 'A comment needs words or a drawing.' }, 400);
    const mentions = await peopleWhoCanRead(g.file, normalizeMentions(body.mentions).filter((m) => m !== g.email));
    const edited = await editReviewComment(comment.id, { body: text, mentions });
    if (!edited) return reviewJson({ error: 'Comment not found' }, 404);
    return reviewJson({ comment: edited }, 200);
  }

  if (typeof body.resolved === 'boolean') {
    const no = refused(g, 'resolve', { isAuthor });
    if (no) return no;
    // A thread is resolved as a whole, from its top.
    if (comment.parentId) return reviewJson({ error: 'Resolve the thread, not a reply.' }, 400);
    const updated = await resolveReviewComment(comment.id, { resolved: body.resolved, by: g.email });
    if (!updated) return reviewJson({ error: 'Comment not found' }, 404);
    const summary = await refreshReviewStatus(g.file.id);
    return reviewJson({ comment: updated, status: summary.status, openComments: summary.openComments }, 200);
  }

  return reviewJson({ error: 'Nothing to change.' }, 400);
}

/**
 * DELETE /api/files/[id]/comments/[cid] — a soft delete. The row stays so the
 * thread under it still reads; its words and drawing are no longer served.
 * The author, or anyone who may change the file.
 */
export async function DELETE(_req, { params }) {
  const g = await openReview(params.id, 'read', { modify: true });
  if (g.error) return g.error;
  const found = await load(g, params.cid);
  if (found.error) return found.error;
  const no = refused(g, 'delete', { isAuthor: found.isAuthor });
  if (no) return no;
  const gone = await deleteReviewComment(found.comment.id);
  if (!gone) return reviewJson({ error: 'Comment not found' }, 404);
  const summary = await refreshReviewStatus(g.file.id);
  return reviewJson({ comment: gone, status: summary.status, openComments: summary.openComments }, 200);
}
