'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Panel, Field } from '@/app/components/ui/Layout';
import { useToast } from '@/app/components/ui/Toast';
import { useConfirm } from '@/app/components/ui/Confirm';

/** Expiry choices in days. '' means never — the API reads a missing value that way. */
const EXPIRIES = [['', 'Never'], ['1', '1 day'], ['7', '7 days'], ['30', '30 days']];

/**
 * Share links for one file.
 *
 * `canShare` is the server's answer (canModifyFile), already decided. Falsy
 * renders nothing at all: POST and DELETE both 403 for a read-only member,
 * and a red box where a panel should be is worse than no panel. It is checked
 * before the hooks so the fetch never runs for someone who cannot see it.
 */
export default function SharePanel({ fileId, origin, canShare }) {
  if (!canShare) return null;
  return <ShareLinks fileId={fileId} origin={origin} />;
}

/**
 * Three facts about the API shape this whole panel:
 *
 *  - Creation is idempotent per (file, mode). createShare returns the token
 *    that already exists and SILENTLY DISCARDS a new expiry or password —
 *    there is no update path at all. So the create form only appears when the
 *    file has no link, and a create that still comes back `reused` (another
 *    tab got there first) says so instead of implying the options took.
 *  - Revoke-then-create is therefore the only way to change a link's options.
 *    It is offered as a button rather than left for the user to deduce.
 *  - `mode: 'private'` is stored but nothing enforces it: the API never sends
 *    a mode and /s/[token] never reads one, so a private row still renders to
 *    the world. There is no mode toggle here — offering one would promise
 *    access control that does not exist.
 */
function ShareLinks({ fileId, origin }) {
  const [shares, setShares] = useState(null); // null until the first load settles
  const [loadError, setLoadError] = useState(null);
  const [forbidden, setForbidden] = useState(false);
  const [days, setDays] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [discarded, setDiscarded] = useState(null); // options a `reused` create threw away
  const toast = useToast();
  const { confirm, confirmElement } = useConfirm();

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/share?fileId=${encodeURIComponent(fileId)}`, { cache: 'no-store' });
      // 403 is either the shares flag being off for the workspace or a file
      // whose links are not ours to see. Both mean "no panel", not "error".
      if (r.status === 403) { setForbidden(true); return; }
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || `Could not load share links (${r.status}).`);
      setShares(out.shares || []);
      setLoadError(null);
    } catch (e) {
      // Deliberately not falling back to an empty list: an empty list here
      // reads as "no link yet" and invites a create for a file that may
      // already have one.
      setLoadError(e.message);
    }
  }, [fileId]);

  useEffect(() => { load(); }, [load]);

  const post = async (body) => {
    const r = await fetch('/api/share', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileId, ...body }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `Could not create the link (${r.status}).`);
    return out.share || {};
  };

  const del = async (token) => {
    const r = await fetch(`/api/share?token=${encodeURIComponent(token)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Could not revoke the link (${r.status}).`);
  };

  const create = async () => {
    setBusy(true);
    try {
      const wanted = { days, password };
      const share = await post({ expiresInDays: days || undefined, password: password || undefined });
      if (share.reused && (wanted.days || wanted.password)) {
        // The row was already there, so this call changed nothing — not the
        // expiry and not the password that were just typed in.
        setDiscarded({ token: share.token, ...wanted });
      } else {
        setDiscarded(null);
        toast.success(share.reused ? 'This file already had a link.' : 'Link created.');
      }
      setDays('');
      setPassword('');
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (token) => {
    const ok = await confirm({
      title: 'Revoke this link?',
      body: 'Anyone holding the URL loses access immediately. A replacement link gets a different URL — this one cannot be brought back.',
      confirmLabel: 'Revoke link',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await del(token);
      setDiscarded(null);
      toast.success('Link revoked.');
    } catch (e) {
      toast.error(e.message);
    } finally {
      await load();
      setBusy(false);
    }
  };

  const recreate = async () => {
    if (!discarded) return;
    const { token, days: d, password: p } = discarded;
    const ok = await confirm({
      title: 'Replace the existing link?',
      body: 'The current URL stops working and a new one is issued with the options you chose. They cannot be added to the link that exists.',
      confirmLabel: 'Revoke and recreate',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await del(token);
      await post({ expiresInDays: d || undefined, password: p || undefined });
      setDiscarded(null);
      toast.success('New link created.');
    } catch (e) {
      // If the revoke landed and the create did not, the file now has no
      // link. The reload below shows that rather than leaving a dead URL on
      // screen.
      toast.error(e.message);
    } finally {
      await load();
      setBusy(false);
    }
  };

  // Nothing painted until we know there is something to paint — the panel can
  // turn out to be forbidden, and a shell that appears and then vanishes is
  // its own kind of error message.
  if (forbidden) return null;
  if (!shares && !loadError) return null;

  const links = shares || [];
  // "expiry and password were" / "password was" — the notice has to name what
  // the create silently dropped, and only that.
  const dropped = discarded && (discarded.days && discarded.password
    ? 'expiry and password were'
    : discarded.password ? 'password was' : 'expiry was');
  // The brand owns the origin: it is the same value the magic-link email and
  // the bucket CORS allowlist use. window.location.origin would hand out a
  // preview-deployment URL that dies with the deployment.
  const base = String(origin || '').replace(/\/+$/, '');

  return (
    <Panel title="Share link" hint="Anyone with the URL can view this file without signing in.">
      {loadError ? (
        <div className="row">
          <p className="small" style={{ color: 'var(--danger)', margin: 0, minWidth: 0 }}>{loadError}</p>
          <div className="spacer" />
          <button className="btn btn-sm" onClick={() => { setLoadError(null); load(); }}>Retry</button>
        </div>
      ) : (
        <>
          {discarded && (
            <div
              className="small"
              style={{
                padding: 'var(--s3)',
                marginBottom: 'var(--s4)',
                borderRadius: 'var(--radius)',
                background: 'color-mix(in srgb, var(--warning) 12%, transparent)',
              }}
            >
              <p style={{ margin: 0 }}>
                This file already had a link, so that one came back unchanged and the {dropped} not
                applied. Options cannot be added to a link that already exists.
              </p>
              <div className="row" style={{ marginTop: 'var(--s2)' }}>
                <button className="btn btn-sm" onClick={recreate} disabled={busy}>Revoke and recreate</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setDiscarded(null)}>Keep the existing link</button>
              </div>
            </div>
          )}

          {links.length > 0 ? (
            <div className="stack" style={{ gap: 'var(--s4)' }}>
              {links.map((s) => (
                <ShareLink key={s.token} share={s} url={`${base}/s/${s.token}`} busy={busy} onRevoke={revoke} />
              ))}
              <p className="muted small" style={{ margin: 0 }}>
                One link per file. To change the expiry or password, revoke it and create a new one.
              </p>
            </div>
          ) : (
            <>
              <Field label="Expires">
                <select className="input" value={days} disabled={busy} onChange={(e) => setDays(e.target.value)}>
                  {EXPIRIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </Field>
              <Field
                label="Password (optional)"
                hint="Stored as a hash, so it is never shown again — send it with the link."
              >
                {/* Not type=password: it is unrecoverable once saved, and the
                    person typing it is the person who has to pass it on. */}
                <input
                  className="input"
                  value={password}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <button className="btn btn-primary" onClick={create} disabled={busy}>
                {busy ? 'Creating…' : 'Create link'}
              </button>
            </>
          )}
        </>
      )}

      {confirmElement}
    </Panel>
  );
}

function ShareLink({ share, url, busy, onRevoke }) {
  const inputRef = useRef(null);
  const toast = useToast();
  const expired = share.expiresAt != null && share.expiresAt < Date.now();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied.');
    } catch {
      // navigator.clipboard is undefined on a non-secure origin and writeText
      // rejects when the document is not focused. The URL is already on
      // screen in a readonly input, so select it and let the user copy it
      // instead of reporting a failure they can do nothing about.
      inputRef.current?.focus();
      inputRef.current?.select();
      toast.push('Copy the selected link — this browser will not let the page write to the clipboard.');
    }
  };

  return (
    <div className="stack" style={{ gap: 'var(--s2)' }}>
      <div className="row" style={{ gap: 'var(--s2)' }}>
        <input
          ref={inputRef}
          className="input mono"
          readOnly
          value={url}
          aria-label="Share link URL"
          onFocus={(e) => e.target.select()}
        />
        <button className="btn btn-sm" onClick={copy}>Copy</button>
      </div>
      <div className="row small muted" style={{ gap: 'var(--s2)', flexWrap: 'wrap' }}>
        <span>
          {share.expiresAt == null ? 'No expiry' : `Expires ${new Date(share.expiresAt).toLocaleDateString()}`}
        </span>
        <span aria-hidden>·</span>
        <span>{share.viewCount} {share.viewCount === 1 ? 'view' : 'views'}</span>
        {share.hasPassword && <span className="tag">Password</span>}
        {expired && <span className="tag tag-danger">Expired</span>}
        {/* A 'private' row is not enforced anywhere — it still opens for
            anyone with the token. Say so rather than let the word reassure. */}
        {share.mode === 'private' && <span className="tag tag-warning">Private (not enforced)</span>}
        <div className="spacer" />
        <button className="btn btn-sm btn-danger" onClick={() => onRevoke(share.token)} disabled={busy}>Revoke</button>
      </div>
    </div>
  );
}
