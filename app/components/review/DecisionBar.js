'use client';

import { useState } from 'react';
import ReviewStatusTag from './ReviewStatusTag';
import { initials, personLabel } from './format';
import { userReviewer } from '@/lib/review';

/**
 * Approve / Request changes, and where everyone else stands.
 *
 * Pressing your current decision again takes it back. Asking for changes
 * takes an optional note — what to change is the useful part of saying so —
 * while approving is one click. The file's status is derived on the server
 * from everyone's current decisions (deriveReviewStatus), not from yours.
 *
 * `reviewer` is whose decision is "yours": a member's is stored under
 * userReviewer(me), a review link's guest's under 'guest:<id>'. Without
 * `canDecide` — a link that takes comments but not approvals, or a guest
 * with no name yet — it only says where people stand, and says nothing at
 * all when nobody has decided.
 */
export default function DecisionBar({ decisions = [], me, reviewer = null, canDecide = true, onDecide, onError }) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const current = decisions.filter((d) => d.status === 'approved' || d.status === 'changes_requested');
  const key = reviewer || (me ? userReviewer(me) : null);
  const mine = (key && current.find((d) => d.reviewer === key)) || null;
  if (!canDecide && current.length === 0) return null;

  const decide = async (status, withNote = null) => {
    setBusy(true);
    try {
      await onDecide(status, withNote);
      setNoting(false);
      setNote('');
    } catch (e) {
      onError?.(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="review-decision" aria-label="Decision">
      {canDecide && (
        <div className="review-decision-buttons">
          <button
            type="button"
            className="btn btn-sm review-approve"
            aria-pressed={mine?.status === 'approved'}
            disabled={busy}
            onClick={() => decide(mine?.status === 'approved' ? null : 'approved')}
          >
            {mine?.status === 'approved' ? 'Approved' : 'Approve'}
          </button>
          <button
            type="button"
            className="btn btn-sm review-changes"
            aria-pressed={mine?.status === 'changes_requested'}
            disabled={busy}
            onClick={() => (mine?.status === 'changes_requested' ? decide(null) : setNoting((v) => !v))}
          >
            {mine?.status === 'changes_requested' ? 'Changes requested' : 'Request changes'}
          </button>
        </div>
      )}

      {canDecide && noting && (
        <div className="review-decision-note">
          <textarea
            className="input"
            rows={2}
            value={note}
            autoFocus
            placeholder="What needs to change? (optional)"
            aria-label="Note for the change request"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); decide('changes_requested', note.trim() || null); }
              if (e.key === 'Escape') setNoting(false);
            }}
          />
          <div className="review-composer-row">
            <div className="spacer" />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNoting(false)}>Cancel</button>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => decide('changes_requested', note.trim() || null)}>
              Request changes
            </button>
          </div>
        </div>
      )}

      {current.length > 0 && (
        <ul className="review-reviewers">
          {current.map((d) => {
            const person = { email: d.email, name: d.name };
            return (
              <li key={d.reviewer} className="review-reviewer">
                <span className="review-avatar" aria-hidden="true">{initials(person)}</span>
                <span className="small truncate" title={d.email || undefined}>
                  {d.reviewer === key ? 'You' : personLabel(person)}
                  {d.guest && d.reviewer !== key ? <span className="muted"> · Guest</span> : null}
                </span>
                <ReviewStatusTag status={d.status} />
                {d.note && <p className="small muted review-reviewer-note">{d.note}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
