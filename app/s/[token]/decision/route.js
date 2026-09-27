import { setReviewDecision, refreshReviewStatus, addReviewWatchers } from '@/lib/db';
import { openGuestReview, guestJson } from '@/lib/share-review';
import { validateDecision, decisionForGuest, guestReviewer } from '@/lib/review';
import { notifyReviewDecision } from '@/lib/review-notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PUT /s/<token>/decision  { status: 'approved' | 'changes_requested' | null, note? }
 *
 * A guest's decision on the file, through a link set to take approvals —
 * a request for comments alone is not one (openGuestReview). It counts
 * toward the file's status like a member's, which is why the sharer has to
 * ask for it. Stored under the guest's key with the name they gave, and the
 * link it came through, so each link's guests see their own decisions and
 * no one else's.
 */
export async function PUT(req, { params }) {
  const g = await openGuestReview(params.token, 'decide');
  if (g.error) return g.error;
  let body;
  try { body = await req.json(); } catch { return guestJson({ error: 'Bad request' }, 400); }
  const checked = validateDecision(body);
  if (checked.error) return guestJson({ error: checked.error }, 400);

  const reviewer = guestReviewer(g.guest.id);
  const decision = await setReviewDecision({
    fileId: g.file.id,
    reviewer,
    status: checked.value.status,
    note: checked.value.note,
    shareToken: g.token,
    reviewerName: g.guest.name,
  });
  await refreshReviewStatus(g.file.id);
  if (decision && checked.value.status) {
    await addReviewWatchers(g.file.id, [g.file.createdBy, g.row?.created_by]).catch(() => {});
    await notifyReviewDecision({ file: g.file, decision, actor: reviewer, actorName: g.guest.name });
  }
  return guestJson({ decision: decision ? decisionForGuest(decision) : null }, 200);
}
