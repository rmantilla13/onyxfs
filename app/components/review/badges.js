'use client';

import ReviewStatusTag from './ReviewStatusTag';
import './review.css';

/**
 * The review badges for a file in the grid and the list: its decision
 * (Approved, Changes requested) and how many threads are still open.
 *
 * One call, so the library page carries no review logic of its own. "In
 * review" is left to the facet and the detail page: on a busy library it
 * would be on nearly every tile and say nothing.
 */
export function reviewBadges(file) {
  const status = file?.reviewStatus;
  const open = Number(file?.openComments) || 0;
  const decided = status === 'approved' || status === 'changes_requested';
  if (!decided && !open) return null;
  return (
    <>
      {decided && <ReviewStatusTag status={status} short />}
      {open > 0 && (
        <span className="tag review-open" title={`${open} open comment${open === 1 ? '' : 's'}`}>{open} open</span>
      )}
    </>
  );
}
