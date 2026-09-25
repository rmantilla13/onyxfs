'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import Dialog from '@/app/components/ui/Dialog';
import { useToast } from '@/app/components/ui/Toast';
import { SHARE_KINDS, SHARE_EXPIRY, MIN_PASSWORD, expiryLabel } from '@/lib/share-kinds';

const KIND_LABEL = Object.fromEntries(SHARE_KINDS.map((k) => [k.id, k.label]));
const dateFmt = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }) : null;

/**
 * Links to one file: make one — public, password or private, with an expiry
 * — and see, copy or revoke the ones that exist. The server decides who may
 * (GET/POST /api/files/[id]/shares); this only asks.
 *
 * A new link is copied as it is made, because copying it is the next thing
 * anyone does. The clipboard can refuse (no focus, an old browser), so the
 * link is always in the list with its own Copy button too.
 */
export default function ShareDialog({ file, open, onClose }) {
  const [shares, setShares] = useState(null);
  const [kind, setKind] = useState('public');
  const [password, setPassword] = useState('');
  const [expires, setExpires] = useState('never');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fresh, setFresh] = useState(null);
  const toast = useToast();
  const id = useId();

  const base = file ? `/api/files/${file.id}/shares` : null;

  useEffect(() => {
    if (!open || !base) return undefined;
    let live = true;
    setShares(null);
    setError(null);
    setFresh(null);
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
        body: JSON.stringify({ kind, password: kind === 'password' ? password : undefined, expires }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { setError(body.error || `Could not make the link (HTTP ${r.status}).`); return; }
      const share = body.share;
      setShares((list) => [share, ...(list || []).filter((s) => s.token !== share.token)]);
      setFresh(share.token);
      setPassword('');
      const copied = await copy(share.token, true);
      toast.success(copied ? 'Link made and copied.' : 'Link made.');
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
                      expiry || 'Never expires',
                      `${s.viewCount} view${s.viewCount === 1 ? '' : 's'}`,
                      s.createdAt && dateFmt ? `made ${dateFmt.format(new Date(s.createdAt))}` : null,
                      s.createdBy ? `by ${s.createdBy}` : null,
                    ].filter(Boolean).join(' · ')}
                  </span>
                </div>
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
