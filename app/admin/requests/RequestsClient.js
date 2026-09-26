'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Dialog from '@/app/components/ui/Dialog';
import { useToast } from '@/app/components/ui/Toast';
import { REQUEST_FILTERS, askedLabel } from '@/lib/admin-requests';
import AdminPage from '../_ui/AdminPage';
import AdminState from '../_ui/AdminState';
import RelativeTime from '../_ui/RelativeTime';
import { useDestructiveConfirm } from '../_ui/DestructiveConfirm';
import { api } from '../_ui/api';

const INVITES = '/api/admin/invites';

/**
 * The queue and its decisions. Approving lets the person sign in with their
 * email; they are not told yet (the "You're in" email is Phase 1), so the
 * toast says so. Revoking removes their sign-in and ends their sessions;
 * their files stay.
 */
export default function RequestsClient({ status, rows, counts }) {
  const router = useRouter();
  const toast = useToast();
  const { confirm, confirmElement } = useDestructiveConfirm();
  const [busy, setBusy] = useState(null);
  const [denying, setDenying] = useState(null);
  const [adding, setAdding] = useState(false);
  const filter = REQUEST_FILTERS.find((f) => f.key === status) || REQUEST_FILTERS[0];

  const act = async (key, fn, done) => {
    setBusy(key);
    try {
      await fn();
      if (done) toast.success(done);
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

  const deny = (r, note) => act(`deny:${r.id}`,
    () => api(INVITES, { method: 'PATCH', json: { id: r.id, status: 'denied', note: note || null } }),
    `Denied ${r.email}.`);

  const revoke = async (r) => {
    const ok = await confirm({
      title: `Revoke access for ${r.email}?`,
      body: 'They can no longer sign in: any open browser session ends now, and the desktop app stops on its next request. Their files, and the drives they were given, stay. They can ask again from the sign-in page.',
      confirmLabel: 'Revoke access',
    });
    if (ok) act(`revoke:${r.id}`, () => api(`${INVITES}?email=${encodeURIComponent(r.email)}`, { method: 'DELETE' }), `Revoked access for ${r.email}.`);
  };

  return (
    <AdminPage
      title="Access requests"
      description="People who asked to sign in, and your answer. Approving lets them in with their email address."
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
          message={status === 'pending' ? 'Requests from the sign-in page appear here, and in Slack when it is connected.' : undefined}
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
                </span>
              </div>
              <div className="request-actions">
                {r.status !== 'approved' && (
                  <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => approve(r)}>
                    {busy === `approve:${r.id}` ? 'Approving…' : 'Approve'}
                  </button>
                )}
                {r.status === 'pending' && (
                  <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => setDenying(r)}>Deny…</button>
                )}
                {r.status === 'approved' && (
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={!!busy || r.envAdmin || r.self}
                    title={r.self ? 'You can’t revoke yourself.' : r.envAdmin ? 'Managed in ADMIN_EMAILS.' : undefined}
                    onClick={() => revoke(r)}
                  >
                    {busy === `revoke:${r.id}` ? 'Revoking…' : 'Revoke access…'}
                  </button>
                )}
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
      {confirmElement}
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
        <p className="small muted admin-note">They can sign in with this address straight away, without asking first. Give them access to drives from each drive’s members.</p>
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
