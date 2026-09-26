'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import CommentThread from './CommentThread';
import Composer from './Composer';
import DecisionBar from './DecisionBar';
import { anchorLabel, commentFrame } from '@/lib/review';
import './review.css';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'mine', label: 'Mine' },
];

/**
 * The Comments tab: the decision bar, the threads with their filters and
 * unread dots, and the composer.
 *
 * Threads on a video run in timeline order, the way an editor works through
 * notes, with general comments after them; on an image, in the order they
 * were made, which is also the order of the numbered pins. "New" is what
 * others wrote since this person last had the panel open (readSeq, fixed
 * for the visit).
 *
 * `feed` is useReviewFeed's; selecting a thread is the page's business (it
 * seeks the player and shows the drawing), so it only reports the choice.
 */
export default function ReviewPanel({
  file, kind, feed, me, canModify, model, knownRate, frame, range, draftApi,
  selectedId, onSelect, composerRef, onComposerFocus, srcSize, onError,
}) {
  const [filter, setFilter] = useState('all');
  const list = useRef(null);

  const { threads, replies, pinNumbers, counts } = useMemo(() => {
    const all = [...feed.comments.values()];
    const byCreated = (a, b) => (a.createdAt || 0) - (b.createdAt || 0);
    const repliesOf = new Map();
    for (const c of all) {
      if (!c.parentId) continue;
      if (!repliesOf.has(c.parentId)) repliesOf.set(c.parentId, []);
      repliesOf.get(c.parentId).push(c);
    }
    for (const r of repliesOf.values()) r.sort(byCreated);
    // A deleted comment nobody answered is simply gone.
    const tops = all.filter((c) => !c.parentId && !(c.deletedAt && !repliesOf.get(c.id)?.length));
    const pins = new Map();
    tops.filter((c) => c.anchor === 'point' && !c.deletedAt).sort(byCreated).forEach((c, i) => pins.set(c.id, i + 1));
    const at = (c) => ((c.anchor === 'frame' || c.anchor === 'range') ? commentFrame(c.frameIn, c.fps, model.fps) : null);
    tops.sort((a, b) => {
      const fa = at(a);
      const fb = at(b);
      if (fa != null && fb != null && fa !== fb) return fa - fb;
      if ((fa == null) !== (fb == null)) return fa == null ? 1 : -1;
      return byCreated(a, b);
    });
    const mine = (c) => c.author?.email === me || (c.mentions || []).includes(me)
      || (repliesOf.get(c.id) || []).some((r) => r.author?.email === me);
    return {
      threads: tops,
      replies: repliesOf,
      pinNumbers: pins,
      counts: {
        all: tops.length,
        open: tops.filter((c) => !c.resolvedAt && !c.deletedAt).length,
        resolved: tops.filter((c) => c.resolvedAt).length,
        mine: tops.filter(mine).length,
        isMine: mine,
      },
    };
  }, [feed.comments, model.fps, me]);

  const shown = threads.filter((c) => {
    if (filter === 'open') return !c.resolvedAt && !c.deletedAt;
    if (filter === 'resolved') return !!c.resolvedAt;
    if (filter === 'mine') return counts.isMine(c);
    return true;
  });

  const readSeq = feed.readSeq;
  const unreadIds = useMemo(() => {
    const isNew = (c) => readSeq != null && !c.pending && (c.seq || 0) > readSeq && c.author?.email !== me && !c.deletedAt;
    return new Set([...feed.comments.values()].filter(isNew).map((c) => c.id));
  }, [feed.comments, readSeq, me]);

  // Bring the selected thread into view when it was chosen from elsewhere —
  // a marker on the timeline, a pin, a notification's link.
  useEffect(() => {
    if (!selectedId || !list.current) return;
    const el = list.current.querySelector(`[data-comment="${CSS.escape(selectedId)}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  const empty = {
    all: kind === 'video' ? 'No comments yet. Press C on the player to comment on a frame.' : 'No comments yet.',
    open: 'Nothing open.',
    resolved: 'Nothing resolved yet.',
    mine: 'Nothing of yours, or mentioning you.',
  }[filter];

  return (
    <div className="review-panel">
      <DecisionBar decisions={[...feed.decisions.values()]} me={me} onDecide={feed.decide} onError={onError} />

      <div className="review-filters" role="group" aria-label="Show comments">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className="btn btn-sm btn-ghost"
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            {counts[f.key] > 0 && <span className="review-count">{counts[f.key]}</span>}
          </button>
        ))}
      </div>

      {feed.error && <p className="small review-error" role="alert">{feed.error}</p>}

      <div className="review-list" ref={list}>
        {!feed.loaded && <p className="small muted">Loading comments…</p>}
        {feed.loaded && shown.length === 0 && <p className="small muted review-empty">{empty}</p>}
        {shown.map((c) => (
          <div key={c.id} data-comment={c.id}>
            <CommentThread
              comment={c}
              replies={replies.get(c.id) || []}
              me={me}
              canModify={canModify}
              anchor={c.anchor === 'frame' || c.anchor === 'range' ? anchorLabel(c, model) : null}
              pinNumber={pinNumbers.get(c.id) ?? null}
              selected={c.id === selectedId}
              unread={unreadIds.has(c.id)}
              unreadIds={unreadIds}
              fileId={file.id}
              onSelect={onSelect}
              onReply={feed.post}
              onUpdate={feed.update}
              onRemove={feed.remove}
              onError={onError}
            />
          </div>
        ))}
      </div>

      <Composer
        fileId={file.id}
        kind={kind}
        model={model}
        knownRate={knownRate}
        frame={frame}
        range={range}
        draftApi={draftApi}
        onPost={feed.post}
        onFocus={onComposerFocus}
        textareaRef={composerRef}
        srcSize={srcSize}
      />
    </div>
  );
}
