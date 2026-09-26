import { setReviewDecision, refreshReviewStatus, addReviewWatchers, displayNamesFor } from '@/lib/db';
import { openReview, reviewJson } from '@/lib/review-guard';
import { validateDecision, userReviewer } from '@/lib/review';
import { notifyReviewDecision } from '@/lib/review-notify';

export const runtime = 'nodejs';

/**
 * PUT /api/files/[id]/decision  { status: 'approved' | 'changes_requested' | null, note? }
 *
 * This person's decision on the file; null takes it back. Anyone who may read
 * the file may decide, as they may comment. The file's status follows from
 * everyone's current decisions (deriveReviewStatus in lib/review.js), and is
 * returned so the caller need not wait for the next poll.
 */
export async function PUT(req, { params }) {
  const g = await openReview(params.id, 'decide');
  if (g.error) return g.error;
  let body;
  try { body = await req.json(); } catch { return reviewJson({ error: 'Bad request' }, 400); }
  const checked = validateDecision(body);
  if (checked.error) return reviewJson({ error: checked.error }, 400);

  const decision = await setReviewDecision({
    fileId: g.file.id,
    reviewer: userReviewer(g.email),
    status: checked.value.status,
    note: checked.value.note,
  });
  const summary = await refreshReviewStatus(g.file.id);
  const name = (await displayNamesFor([g.email])).get(g.email) || null;
  if (decision && checked.value.status) {
    await addReviewWatchers(g.file.id, [g.email]).catch(() => {});
    await notifyReviewDecision({ file: g.file, decision, actor: g.email, actorName: name });
  }
  return reviewJson({
    decision: decision ? { ...decision, name } : null,
    status: summary.status,
    openComments: summary.openComments,
  }, 200);
}
