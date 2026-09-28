'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import FilePreview from '@/app/components/file/FilePreview';
import ReviewPanel from '@/app/components/review/ReviewPanel';
import useReviewFeed from '@/app/components/review/useReviewFeed';
import useReviewStage from '@/app/components/review/useReviewStage';
import { useToast } from '@/app/components/ui/Toast';
import { effectiveKind } from '@/lib/media';
import { toRate, ASSUMED_RATE } from '@/lib/video-time';
import { guestReviewer, GUEST_NAME_MAX } from '@/lib/review';

/**
 * A review link's file, for the people it reaches: the picture with the
 * same review tools a member has on the file's page — comments on frames,
 * ranges and spots, drawings, markers on the timeline, replies — and, on a
 * link set to take approvals, Approve and Request changes (`level`).
 *
 * Everything goes through the link (/s/<token>/…, lib/share-review.js),
 * which decides again on every request what this link may see and do. A
 * guest reads the comments at once; to write, they give a name first — kept
 * in a cookie for this link, so they are the same person when they come
 * back, and can edit what they wrote. `guest` is who the server says this
 * browser already is, or null.
 */
export default function ShareReview({ file, token, level, guest: initialGuest = null }) {
  const [guest, setGuest] = useState(initialGuest);
  const [naming, setNaming] = useState(false);
  const toast = useToast();
  const kind = effectiveKind(file);
  const md = file.metadata || {};

  // The frame model, as the file page has it: the probed rate, or the
  // assumed one. A guest never probes the file; an editor's visit does.
  const known = toRate(md.fps);
  const fpsKey = known ? `${known.num}/${known.den}` : '';
  const model = useMemo(() => ({
    fps: toRate(fpsKey) || ASSUMED_RATE,
    tcStart: Number.isInteger(md.tcStart) ? md.tcStart : 0,
    dropFrame: md.dropFrame === true,
  }), [fpsKey, md.tcStart, md.dropFrame]);

  const me = guest ? guestReviewer(guest.id) : null;
  const author = useMemo(() => (guest ? { email: null, name: guest.name, guest: true, guestId: guest.id } : null), [guest]);
  const feed = useReviewFeed(file.id, { base: `/s/${encodeURIComponent(token)}`, me, author });

  const player = useRef(null);
  const aside = useRef(null);
  const nameInput = useRef(null);
  // On a phone the comments are under the picture: a marker or a pin
  // brings them up.
  const reveal = useCallback(() => aside.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }), []);
  const stage = useReviewStage({ kind, feed, model, player, onReveal: reveal });
  const onError = useCallback((e) => toast.error(e?.message || 'Something went wrong.'), [toast]);

  // C on the player: a comment on this frame — or, before a name is given,
  // the name, which comes first.
  const { onComment: commentHere, composer } = stage;
  const onComment = useCallback(() => {
    if (guest) { commentHere(); return; }
    reveal();
    requestAnimationFrame(() => nameInput.current?.focus());
  }, [guest, commentHere, reveal]);

  const named = (next) => {
    const first = !guest;
    setGuest(next);
    setNaming(false);
    if (first) requestAnimationFrame(() => composer.current?.focus());
  };

  const canWrite = !!guest && !naming;
  const footer = !guest || naming ? (
    <GuestName
      token={token}
      current={guest?.name || ''}
      approve={level === 'approve'}
      inputRef={nameInput}
      onNamed={named}
      onCancel={guest ? () => setNaming(false) : null}
    />
  ) : (
    <p className="small muted share-guest">
      Commenting as <strong className="share-guest-name">{guest.name}</strong>
      {' · '}
      <button type="button" className="share-guest-change" onClick={() => setNaming(true)}>Change</button>
    </p>
  );

  return (
    <div className="file-detail-body share-review-body">
      <div style={{ minWidth: 0 }}>
        <FilePreview
          ref={player}
          file={file}
          overlay={stage.overlay}
          markers={stage.markers}
          onMarkerClick={stage.pick}
          onFrameChange={stage.onFrameChange}
          onRangeChange={stage.setRange}
          onComment={onComment}
        />
      </div>
      <aside ref={aside} style={{ minWidth: 0 }} aria-label="Comments">
        <ReviewPanel
          file={file}
          kind={kind}
          feed={feed}
          me={me}
          canModify={false}
          model={model}
          knownRate={!!known}
          frame={stage.frame}
          range={stage.range}
          draftApi={stage.draftApi}
          selectedId={stage.selectedId}
          onSelect={stage.selectComment}
          composerRef={composer}
          onComposerFocus={stage.onComposerFocus}
          onAnchor={stage.holdFrame}
          srcSize={{ w: Number(md.width) || 0, h: Number(md.height) || 0 }}
          onError={onError}
          guest
          reviewer={me}
          canComment={canWrite}
          canDecide={canWrite && level === 'approve'}
          footer={footer}
        />
      </aside>
    </div>
  );
}

/**
 * The name a guest comments under: asked once, before their first comment,
 * and changeable after. What it is for is said where it is asked.
 */
function GuestName({ token, current, approve, inputRef, onNamed, onCancel }) {
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    const value = name.trim();
    if (!value) { setError('Enter your name.'); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/s/${encodeURIComponent(token)}/guest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: value }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) { setError(out.error || `Could not save your name (HTTP ${r.status}).`); return; }
      onNamed(out.guest);
    } catch (err) {
      setError(err.message || 'Could not save your name.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="review-composer share-guest-form" onSubmit={submit}>
      <label className="stack" style={{ gap: 'var(--s1)' }}>
        <span className="small">
          <strong>{onCancel ? 'Your name' : `Add your name to comment${approve ? ' or approve' : ''}`}</strong>
        </span>
        <input
          ref={inputRef}
          className="input"
          value={name}
          maxLength={GUEST_NAME_MAX}
          onChange={(e) => { setName(e.target.value); if (error) setError(null); }}
          placeholder="Your name"
          autoComplete="name"
          autoFocus={!!onCancel}
        />
      </label>
      <p className="small muted" style={{ margin: 0 }}>
        It is shown with your comments, to the people who shared this file and to anyone else with this link.
      </p>
      <div className="review-composer-row">
        <div className="spacer" />
        {onCancel && <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>}
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          {busy ? 'Saving…' : onCancel ? 'Save' : 'Continue'}
        </button>
      </div>
      {error && <p className="small review-error" role="alert">{error}</p>}
    </form>
  );
}
