'use client';

import { STATUS_LABELS } from '@/lib/review';

// Existing tag tones, so the status reads like every other tag in the app
// and follows the brand and the dark scheme without a colour of its own.
const TONE = { approved: 'tag-accent', changes_requested: 'tag-warning', in_review: '' };

/** A file's review status as a tag: In review, Changes requested, Approved. Nothing when it has none. */
export default function ReviewStatusTag({ status, className = '' }) {
  if (!status || !STATUS_LABELS[status]) return null;
  return (
    <span className={['tag', 'review-status', TONE[status], className].filter(Boolean).join(' ')}>
      {STATUS_LABELS[status]}
    </span>
  );
}
