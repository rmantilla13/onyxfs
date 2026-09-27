'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import Dialog from '@/app/components/ui/Dialog';
import { useToast } from '@/app/components/ui/Toast';
import { SHARE_KINDS, SHARE_EXPIRY, SHARE_REVIEW, MIN_PASSWORD, expiryLabel } from '@/lib/share-kinds';
import { effectiveKind } from '@/lib/media';

const KIND_LABEL = Object.fromEntries(SHARE_KINDS.map((k) => [k.id, k.label]));
const LEVEL_LABEL = { view: 'View only', comment: 'Can comment', approve: 'Can approve' };
const LEVEL_RANK = { view: 0, comment: 1, approve: 2 };
const dateFmt = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }) : null;

/** What a level lets people do, said for this file: frames on a video, spots on a picture. */
function levelDetail(level, video) {
  if (level === 'comment') {
    return video
      ? 'They can comment on frames and ranges, draw on the picture, and reply.'
      : 'They can pin comments to spots, draw on the picture, and reply.';
  }
  if (level === 'approve') return 'They can comment, and approve it or ask for changes — which counts toward its status.';
  return 'They can open and download it.';
}

/**
 * Links to one file: make one — public, password or private, with an expiry
 * — and see, copy or revoke the ones that exist. The server decides who may
 * (GET/POST /api/files/[id]/shares); this only asks.
 *
 * A public or password link to a photo or a video can also take comments,
 * made with the review tools on the share page — and approvals, when the
 * sharer asks for those too (SHARE_REVIEW). `canReview` says the server
 * would let this person make such a link; it decides again. A link's level
 * can be changed after it is sent (PATCH …/shares/[token]) — turning
 * comments on needs `canReview`, turning them off anyone here may do.
 *
 * A new link is copied as it is made, because copying it is the next thing
 * anyone does. The clipboard can refuse (no focus, an old browser), so the
 * link is always in the list with its own Copy button too.
 */
export default function ShareDialog({ file, open, onClose, canReview = false }) {
  const [shares, setShares] = useState(null);
  const [kind, setKind] = useState('public');
  const [password, setPassword] = useState('');
  const [expires, setExpires] = useState('never');
  const [review, setReview] = useState('view');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fresh, setFresh] = useState(null);
  const toast = useToast();
  const id = useId();

  const base = file ? `/api/files/${file.id}/shares` : null;
  const video = file ? effectiveKind(file) === 'video' : false;
  const level = kind === 'private' ? 'view' : review;

  useEffect(() => {
    if (!open || !base) return undefined;
    let live = true;
    setShares(null);
    setError(null);
    setFresh(null);
    // Comments and approvals are asked for each time, never carried over
    // from the last file the dialog was open for.
    setReview('view');
    fetch(base)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!live) return;
        if (!r.ok) { setError(body.error || `Could not load the links (HTTP ${r.status}).`); setShares([]); return; }
        setShares(body.shares || []);
      })
      .catch((e) => { if (live) { setError(e.message); setShares([]); } });
    return () => { live = false; };
  }, [open, base]);

  const linkFor = (token) => `${window.location.origin}/s/${token}`;

  const copy = useCallback(async (token, quiet = false) => {
    try {
      await navigator.clipboard.writeText(linkFor(token));
      if (!quiet) toast.success('Link copied.');
      return true;
    } catch {
      if (!quiet) toast.error('Could not copy. Select the link and copy it instead.');
      return false;
    }
  }, [toast]);

  const create = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (kind === 'password' && password.length < MIN_PASSWORD) {
      setError(`Use a password of at least ${MIN_PASSWORD} characters.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind,
          password: kind === 'password' ? password : undefined,
          expires,
          review: canReview && level !== 'view' ? level : undefined,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { setError(body.error || `Could not make the link (HTTP ${r.status}).`); return; }
      const share = body.share;
      setShares((list) => [share, ...(list || []).filter((s) => s.token !== share.token)]);
      setFresh(share.token);
      setPassword('');
      const copied = await copy(share.token, true);
      const what = share.review ? 'Review link' : 'Link';
      toast.success(copied ? `${what} made and copied.` : `${what} made.`);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (token) => {
    const r = await fetch(`${base}/${encodeURIComponent(token)}`, { method: 'DELETE' });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { toast.error(body.error || `Could not revoke the link (HTTP ${r.status}).`); return; }
    setShares((list) => (list || []).filter((s) => s.token !== token));
    toast.success('Link revoked. It stops working now.');
  };

  const changeLevel = async (token, next) => {
    const r = await fetch(`${base}/${encodeURIComponent(token)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ review: next }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { toast.error(body.error || `Could not change the link (HTTP ${r.status}).`); return; }
    if (body.share) setShares((list) => (list || []).map((s) => (s.token === token ? body.share : s)));
    toast.success(next === 'view'
      ? 'The link is view only now. Comments already made stay on the file.'
      : `People with the link ${next === 'approve' ? 'can comment and approve' : 'can comment'} now.`);
  };

  // A link's level can go up only for someone who may make review links,
  // and down for anyone here — the route holds both to the same rule.
  const levelsFor = (s) => SHARE_REVIEW.filter((l) => canReview || LEVEL_RANK[l.id] <= LEVEL_RANK[s.review || 'view']);

  if (!file) return null;
  return (
    <Dialog open={open} onClose={onClose} title="Share" wide>
      <p className="share-dialog-file" title={file.name}>{file.name}</p>

      <form id={id} onSubmit={create} className="stack" style={{ gap: 'var(--s3)' }}>
        <fieldset className="share-kinds">
          <legend className="small muted">Who can open it</legend>
          {SHARE_KINDS.map((k) => (
            <label key={k.id} className={`share-kind${kind === k.id ? ' is-on' : ''}`}>
              <input type="radio" name="kind" value={k.id} checked={kind === k.id} onChange={() => { setKind(k.id); setError(null); }} />
              <span className="share-kind-text">
                <strong>{k.label}</strong>
                <span className="small muted">{k.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {canReview && (
          <fieldset className="share-review" disabled={kind === 'private'}>
            <legend className="small muted">What they can do</legend>
            <div className="share-segments">
              {SHARE_REVIEW.map((l) => (
                <label key={l.id} className={`share-segment${level === l.id ? ' is-on' : ''}`}>
                  <input
                    type="radio"
                    name="review"
                    value={l.id}
                    checked={level === l.id}
                    onChange={() => { setReview(l.id); setError(null); }}
                  />
                  <span>{l.label}</span>
                </label>
              ))}
            </div>
            <p className="small muted share-review-detail">
              {kind === 'private'
                ? 'A private link opens only for members, who comment on the file itself.'
                : levelDetail(level, video)}
            </p>
          </fieldset>
        )}

        <div className="share-options">
          {kind === 'password' && (
            <label className="stack" style={{ gap: 'var(--s1)', flex: '1 1 220px' }}>
              <span className="small">Password</span>
              {/* Text, not password: the sharer is choosing it to send on,
                  and needs to see what they typed. */}
              <input
                className="input"
                type="text"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(null); }}
                placeholder={`At least ${MIN_PASSWORD} characters`}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          )}
          <label className="stack" style={{ gap: 'var(--s1)', flex: '0 1 180px' }}>
            <span className="small">Expires</span>
            <select className="input" value={expires} onChange={(e) => setExpires(e.target.value)}>
              {SHARE_EXPIRY.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </label>
          <button type="submit" className="btn btn-primary share-create" disabled={busy}>
            {busy ? 'Making…' : 'Make link'}
          </button>
        </div>
        {error && <p className="small" role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p>}
      </form>

      <h3 className="share-list-title">Links to this file</h3>
      {shares == null ? (
        <p className="small muted">Loading…</p>
      ) : shares.length === 0 ? (
        <p className="small muted">None yet. Nobody outside can open this file.</p>
      ) : (
        <ul className="share-list">
          {shares.map((s) => {
            const expiry = expiryLabel(s.expiresAt);
            const expired = expiry === 'Expired';
            const editable = !expired && s.kind !== 'private' && (canReview || !!s.review);
            return (
              <li key={s.token} className={`share-row${s.token === fresh ? ' is-fresh' : ''}${expired ? ' is-expired' : ''}`}>
                <span className={`tag share-tag share-tag-${s.kind}`}>{KIND_LABEL[s.kind] || s.kind}</span>
                <div className="share-row-main">
                  <input
                    className="share-link"
                    readOnly
                    value={linkFor(s.token)}
                    aria-label={`${KIND_LABEL[s.kind]} link`}
                    onFocus={(e) => e.target.select()}
                  />
                  <span className="small muted">
                    {[
                      !editable && s.review ? LEVEL_LABEL[s.review] : null,
                      expiry || 'Never expires',
                      `${s.viewCount} view${s.viewCount === 1 ? '' : 's'}`,
                      s.createdAt && dateFmt ? `made ${dateFmt.format(new Date(s.createdAt))}` : null,
                      s.createdBy ? `by ${s.createdBy}` : null,
                    ].filter(Boolean).join(' · ')}
                  </span>
                </div>
                {editable && (
                  <select
                    className={`input share-level${s.review ? ' is-review' : ''}`}
                    value={s.review || 'view'}
                    onChange={(e) => changeLevel(s.token, e.target.value)}
                    aria-label="What people with this link can do"
                  >
                    {levelsFor(s).map((l) => <option key={l.id} value={l.id}>{LEVEL_LABEL[l.id]}</option>)}
                  </select>
                )}
                {!expired && <button type="button" className="btn btn-sm" onClick={() => copy(s.token)}>Copy</button>}
                <button type="button" className="btn btn-sm btn-ghost share-revoke" onClick={() => revoke(s.token)}>Revoke</button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
