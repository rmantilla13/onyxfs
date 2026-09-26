'use client';

import { STATUS_LABELS } from '@/lib/review';

// Existing tag tones, so the status reads like every other tag in the app
// and follows the brand and the dark scheme without a colour of its own.
const TONE = { approved: 'tag-accent', changes_requested: 'tag-warning', in_review: '' };
// For a grid tile, where "Changes requested" beside the size would wrap.
const SHORT = { approved: 'Approved', changes_requested: 'Changes', in_review: 'In review' };

/**
 * A file's review status as a tag: In review, Changes requested, Approved.
 * Nothing when it has none. `short` is the tile's form, with the full label
 * kept for the tooltip and screen readers.
 */
export default function ReviewStatusTag({ status, short = false, className = '' }) {
  if (!status || !STATUS_LABELS[status]) return null;
  return (
    <span
      className={['tag', 'review-status', TONE[status], className].filter(Boolean).join(' ')}
      title={short ? STATUS_LABELS[status] : undefined}
      aria-label={short ? STATUS_LABELS[status] : undefined}
    >
      {short ? SHORT[status] : STATUS_LABELS[status]}
    </span>
  );
}
