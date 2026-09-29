'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Dialog from '@/app/components/ui/Dialog';
import { useToast } from '@/app/components/ui/Toast';
import { useConfirm } from '@/app/components/ui/Confirm';
import { REQUEST_FILTERS, askedLabel, revokeBlockedReason } from '@/lib/admin-requests';
import { claimedDrivesMessage } from '@/lib/admin-drives';
import AdminPage from '../_ui/AdminPage';
import AdminState from '../_ui/AdminState';
import RelativeTime from '../_ui/RelativeTime';
import CopyButton from '../_ui/CopyButton';
import { useDestructiveConfirm } from '../_ui/DestructiveConfirm';
import { api } from '../_ui/api';

const INVITES = '/api/admin/invites';
const PASSWORDS = '/api/admin/passwords';

/**
 * Who may sign in: the people admins added, and any requests made before
 * the sign-in page stopped taking them. Approving lets the person sign in
 * with their email; they are not told yet (the "You're in" email is Phase
 * 1), so the toast says so. Revoking removes their sign-in and ends their
 * sessions; their files stay.
 */
export default function RequestsClient({ status, rows, counts }) {
  const router = useRouter();
  const toast = useToast();
  const { confirm, confirmElement } = useDestructiveConfirm();
  const { confirm: ask, confirmElement: askElement } = useConfirm();
  const [busy, setBusy] = useState(null);
  const [denying, setDenying] = useState(null);
  const [adding, setAdding] = useState(false);
  const [passwordFor, setPasswordFor] = useState(null);
  const filter = REQUEST_FILTERS.find((f) => f.key === status) || REQUEST_FILTERS[0];

  // `done` is the success toast, or a function of the answer that says it.
  const act = async (key, fn, done) => {
    setBusy(key);
    try {
      const result = await fn();
      if (done) toast.success(typeof done === 'function' ? done(result) : done);
      router.refresh();
      return true;
    } catch (e) {
      toast.error(e.message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const approve = (r) => act(`approve:${r.id}`,
    () => api(INVITES, { method: 'PATCH', json: { id: r.id, status: 'approved' } }),
    `${r.email} can sign in now. They are not emailed about it yet — let them know.`);

  // A denial was someone's deliberate answer; turning it round asks first.
  const approveDenied = async (r) => {
    const ok = await ask({
      title: `Approve ${r.email} after all?`,
      body: `They were denied${r.reviewedBy && r.reviewedBy !== 'system-bootstrap' ? ` by ${r.reviewedBy}` : ''}. Approving lets them sign in with this address.`,
      confirmLabel: 'Approve',
      danger: false,
    });
    if (ok) approve(r);
  };

  const deny = (r, note) => act(`deny:${r.id}`,
    () => api(INVITES, { method: 'PATCH', json: { id: r.id, status: 'denied', note: note || null } }),
    `Denied ${r.email}.`);

  const revoke = async (r) => {
    // What DELETE ?email= does now (removePerson): sign-in, drive access,
    // devices and the links they made all go; their files stay; and a drive
    // they were the only owner of becomes this admin's, so it keeps one.
    const ok = await confirm({
      title: `Remove ${r.email}?`,
      body: 'They can no longer sign in, and lose their drive access, devices and the links they made. Any open browser session ends on its next request, and the desktop app stops on its next request. Files they uploaded stay, and any drive they are the only owner of becomes yours. You can add them again later.',
      confirmLabel: 'Remove',
    });
    if (ok) {
      act(`revoke:${r.id}`, () => api(`${INVITES}?email=${encodeURIComponent(r.email)}`, { method: 'DELETE' }), (res) => {
        const claimed = res?.removed?.claimed || [];
        if (!claimed.length) return `Removed ${r.email}.`;
        return `Removed ${r.email}. ${claimedDrivesMessage({ claimed })} They were ${claimed.length === 1 ? 'its' : 'their'} only owner.`;
      });
    }
  };

  return (
    <AdminPage
      title="Access requests"
      description="Who can sign in. Nobody can ask from the sign-in page: add someone here, and they sign in with their email address."
      actions={<button type="button" className="btn" onClick={() => setAdding(true)}>Add someone…</button>}
      toolbar={(
        <nav className="admin-seg" aria-label="Requests">
          {REQUEST_FILTERS.map((f) => (
            <Link
              key={f.key}
              href={f.key === 'pending' ? '/admin/requests' : `/admin/requests?status=${f.key}`}
              aria-current={f.key === status ? 'page' : undefined}
              scroll={false}
            >
              {f.label}
              <span className="admin-seg-count">{counts[f.key] ?? 0}</span>
            </Link>
          ))}
        </nav>
      )}
    >
      {rows.length === 0 ? (
        <AdminState
          kind="empty"
          title={filter.empty}
          message={status === 'pending' ? 'The sign-in page no longer takes requests. Add someone to let them in.' : undefined}
        />
      ) : (
        <ul className="requests" aria-label={`${filter.label} requests`}>
          {rows.map((r) => (
            <li key={r.id} className="card request">
              <div className="request-who">
                <span className="request-name">{r.name || r.email}</span>
                {r.name && <span className="request-email small muted" title={r.email}>{r.email}</span>}
                <span className="request-meta small muted">
                  {r.status === 'pending' && <RelativeTime ms={r.requestedAt} prefix="Asked " />}
                  {r.status !== 'pending' && r.reviewedAt && (
                    <span>
                      {r.status === 'approved' ? 'Approved' : 'Denied'}
                      {r.reviewedBy && r.reviewedBy !== 'system-bootstrap' ? ` by ${r.reviewedBy}` : ''}{' '}
                      <RelativeTime ms={r.reviewedAt} />
                    </span>
                  )}
                  {askedLabel(r) && <span className="tag tag-warning">{askedLabel(r)}</span>}
                  {r.envAdmin && <span className="tag tag-accent">Admin</span>}
                  {r.password && <span className="tag" title="Signs in with a password an admin gave them">Password</span>}
                </span>
              </div>
              <div className="request-actions">
                {r.status === 'pending' && (
                  <>
                    <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => approve(r)}>
                      {busy === `approve:${r.id}` ? 'Approving…' : 'Approve'}
                    </button>
                    <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => setDenying(r)}>Deny…</button>
                  </>
                )}
                {/* Reversing a denial is not the page's main act: quiet, and it asks. */}
                {r.status === 'denied' && (
                  <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => approveDenied(r)}>
                    {busy === `approve:${r.id}` ? 'Approving…' : 'Approve instead…'}
                  </button>
                )}
                {/* For an account nobody reads the mail of, such as App Review's.
                    Admins sign in with the link only, so they are never offered one. */}
                {r.status === 'approved' && !r.envAdmin && (
                  <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => setPasswordFor(r)}>
                    Password…
                  </button>
                )}
                {/* A column of red buttons reads as alarm: the danger is in the confirm. */}
                {r.status === 'approved' && (revokeBlockedReason(r) ? (
                  <span className="small muted request-locked">{revokeBlockedReason(r)}</span>
                ) : (
                  <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => revoke(r)}>
                    {busy === `revoke:${r.id}` ? 'Removing…' : 'Remove…'}
                  </button>
                ))}
              </div>
              {(r.reason || (r.reviewNote && r.status === 'denied')) && (
                <div className="request-body">
                  {r.reason && <blockquote className="admin-quote small">{r.reason}</blockquote>}
                  {/* A denial's note is an admin's own words; an approval's is
                      a stamp the invite code writes ("Added directly by admin"). */}
                  {r.reviewNote && r.status === 'denied' && (
                    <p className="small muted admin-note">Note: {r.reviewNote}</p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <DenyDialog
        request={denying}
        onClose={() => setDenying(null)}
        onDeny={async (note) => { const r = denying; setDenying(null); await deny(r, note); }}
      />
      <AddDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(email) => {
          setAdding(false);
          toast.success(`${email} can sign in now. They are not emailed about it yet — let them know.`);
          router.refresh();
        }}
      />
      <PasswordDialog
        request={passwordFor}
        onClose={() => setPasswordFor(null)}
        onChanged={() => router.refresh()}
        onRemoved={(email) => {
          setPasswordFor(null);
          toast.success(`${email} has no password now, and signs in with an emailed link.`);
          router.refresh();
        }}
      />
      {confirmElement}
      {askElement}
    </AdminPage>
  );
}

/** Deny, with a note for the other admins. The person is not told. */
function DenyDialog({ request, onClose, onDeny }) {
  const [note, setNote] = useState('');
  const id = useId();
  useEffect(() => { if (request) setNote(''); }, [request]);
  return (
    <Dialog
      open={!!request}
      onClose={onClose}
      title={request ? `Deny ${request.email}?` : 'Deny'}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form={id} className="btn btn-danger">Deny</button>
        </>
      )}
    >
      <form id={id} className="admin-form" onSubmit={(e) => { e.preventDefault(); onDeny(note.trim()); }}>
        <p className="small muted admin-note">They are not told. They can’t sign in, and asking again keeps this answer until an admin changes it.</p>
        <label className="admin-field">
          <span className="admin-field-label">Note <span className="muted">(optional, for admins)</span></span>
          <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={3} />
        </label>
      </form>
    </Dialog>
  );
}

/** Let someone in without a request (POST /api/admin/invites). */
function AddDialog({ open, onClose, onAdded }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    setEmail(''); setName(''); setError(null); setBusy(false);
    ref.current?.focus();
  }, [open]);

  const submit = async (e) => {
    e.preventDefault();
    const addr = email.trim().toLowerCase();
    if (!addr.includes('@')) { setError('Enter an email address.'); return; }
    setBusy(true); setError(null);
    try {
      await api(INVITES, { method: 'POST', json: { email: addr, name: name.trim() || undefined } });
      onAdded(addr);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add someone"
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form={id} className="btn btn-primary" disabled={busy}>{busy ? 'Adding…' : 'Add'}</button>
        </>
      )}
    >
      <form id={id} className="admin-form" onSubmit={submit} noValidate>
        <p className="small muted admin-note">They can sign in with this address straight away. Give them access to drives from each drive’s members.</p>
        <label className="admin-field">
          <span className="admin-field-label">Email</span>
          <input ref={ref} className="input" type="email" value={email} onChange={(e) => { setEmail(e.target.value); setError(null); }} placeholder="someone@example.com" autoComplete="off" />
        </label>
        <label className="admin-field">
          <span className="admin-field-label">Name <span className="muted">(optional)</span></span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </label>
        {error && <p className="small admin-inline-error" role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}

/**
 * A password to sign in with instead of an emailed link, for an account
 * nobody reads the mail of — App Review's (POST/DELETE /api/admin/passwords).
 * The server makes it and it is shown here once, so the dialog does not close
 * on a stray click while it is on screen.
 */
function PasswordDialog({ request, onClose, onChanged, onRemoved }) {
  const [made, setMade] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!request) return;
    setMade(null); setBusy(null); setError(null);
  }, [request]);

  const make = async () => {
    setBusy('make'); setError(null);
    try {
      const body = await api(PASSWORDS, { method: 'POST', json: { email: request.email } });
      setMade(body.password);
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('remove'); setError(null);
    try {
      await api(PASSWORDS, { method: 'DELETE', json: { email: request.email } });
      onRemoved(request.email);
    } catch (err) {
      setError(err.message);
      setBusy(null);
    }
  };

  const has = !!request?.password;
  return (
    <Dialog
      open={!!request}
      onClose={onClose}
      dismissable={!made}
      title={request ? `A password for ${request.email}` : 'Password'}
      footer={made ? (
        <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
      ) : (
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          {has && (
            <button type="button" className="btn btn-danger" disabled={!!busy} onClick={remove}>
              {busy === 'remove' ? 'Removing…' : 'Remove password'}
            </button>
          )}
          <button type="button" className="btn btn-primary" disabled={!!busy} onClick={make}>
            {busy === 'make' ? 'Making…' : has ? 'Make a new one' : 'Make a password'}
          </button>
        </>
      )}
    >
      <div className="admin-form">
        {made ? (
          <>
            <p className="small admin-note">Copy it now: it is not shown again, and only a new one can replace it.</p>
            <div style={{ display: 'flex', gap: 'var(--s2)', alignItems: 'center' }}>
              <input className="input mono" readOnly value={made} aria-label="Password" onFocus={(e) => e.target.select()} />
              <CopyButton text={made} />
            </div>
            <p className="small muted admin-note">
              They sign in from the sign-in page with “Sign in with a password”. For App Review, enter this address and
              password in App Store Connect under TestFlight → Test Information → Beta App Review Information.
            </p>
          </>
        ) : has ? (
          <p className="small muted admin-note">
            They have a password{request.password.setBy ? `, made by ${request.password.setBy}` : ''}
            {request.password.setAt ? <> <RelativeTime ms={request.password.setAt} /></> : null}. A new one stops the old
            one working at once. Removing it leaves them the emailed link; a device they already signed in stays signed in.
          </p>
        ) : (
          <p className="small muted admin-note">
            For an account that can’t use an emailed link, such as an App Store reviewer’s. The password is made for
            them and shown to you once. They can still sign in with a link too.
          </p>
        )}
        {error && <p className="small admin-inline-error" role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}
