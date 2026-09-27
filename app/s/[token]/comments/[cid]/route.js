import { editReviewComment, deleteReviewComment, refreshReviewStatus } from '@/lib/db';
import { openGuestReview, loadForGuest, guestJson } from '@/lib/share-review';
import { BODY_MAX, commentForGuest } from '@/lib/review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH /s/<token>/comments/[cid]  { body }
 *
 * A guest edits the words of a comment of their own — theirs by the id in
 * their signed cookie, never by a name. Resolving is the team's: a guest
 * who changes their mind deletes the comment instead.
 */
export async function PATCH(req, { params }) {
  const g = await openGuestReview(params.token, 'edit');
  if (g.error) return g.error;
  let body;
  try { body = await req.json(); } catch { return guestJson({ error: 'Bad request' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return guestJson({ error: 'Bad request' }, 400);
  const found = await loadForGuest(g, params.cid);
  if (found.error) return found.error;

  if (typeof body.body === 'string') {
    if (!found.isAuthor) return guestJson({ error: 'Only the person who wrote a comment can edit it.' }, 403);
    const text = body.body.replace(/\r\n?/g, '\n').trim();
    if (text.length > BODY_MAX) return guestJson({ error: `A comment can be up to ${BODY_MAX.toLocaleString('en-US')} characters.` }, 400);
    if (!text && !found.comment.annotation) return guestJson({ error: 'A comment needs words or a drawing.' }, 400);
    const edited = await editReviewComment(found.comment.id, { body: text, mentions: [] });
    if (!edited) return guestJson({ error: 'Comment not found' }, 404);
    return guestJson({ comment: commentForGuest(edited) }, 200);
  }
  if (typeof body.resolved === 'boolean') {
    return guestJson({ error: 'Comments are resolved by the people who shared the file.' }, 403);
  }
  return guestJson({ error: 'Nothing to change.' }, 400);
}

/**
 * DELETE /s/<token>/comments/[cid] — a guest takes back a comment of their
 * own. The soft delete members get: the row keeps its place in the thread,
 * and its words and drawing are no longer served.
 */
export async function DELETE(_req, { params }) {
  const g = await openGuestReview(params.token, 'edit');
  if (g.error) return g.error;
  const found = await loadForGuest(g, params.cid);
  if (found.error) return found.error;
  if (!found.isAuthor) return guestJson({ error: 'Only the person who wrote a comment can delete it.' }, 403);
  const gone = await deleteReviewComment(found.comment.id);
  if (!gone) return guestJson({ error: 'Comment not found' }, 404);
  await refreshReviewStatus(g.file.id);
  return guestJson({ comment: commentForGuest(gone) }, 200);
}
