'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Dialog from '@/app/components/ui/Dialog';
import { drivePrefixFor } from '@/lib/folder-ops';
import { newDriveRequest } from '@/lib/admin-drives';

const BLANK = {
  name: '', prefix: '', prefixTouched: false,
  bucket: '', region: '', endpoint: '', roleArn: '', accessKeyId: '', secretAccessKey: '',
};

/**
 * Make a drive: one dialog for the files page and Admin → Drives, so both
 * make drives the same way. Admins only — the route (POST
 * /api/admin/filespaces) checks.
 *
 * The name is what people see; the folder in the bucket is where its files
 * live, filled in from the name (drivePrefixFor) and editable until the
 * drive exists — after that it is fixed while anything is stored there,
 * since moving it would strand every file under it.
 *
 * "Advanced" is for a drive that lives somewhere other than the Storage
 * bucket: another bucket, region or endpoint, a role to assume, or keys of
 * its own. Left alone, the drive uses the Storage settings.
 */
export default function NewDriveDialog({ open, onClose, onCreated }) {
  const [form, setForm] = useState(BLANK);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const nameRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setForm(BLANK); setError(null); setBusy(false);
    nameRef.current?.focus();
  }, [open]);

  const set = (k) => (e) => { setError(null); setForm((f) => ({ ...f, [k]: e.target.value })); };
  const shownPrefix = form.prefixTouched ? form.prefix : drivePrefixFor(form.name);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const req = newDriveRequest(form, drivePrefixFor);
    if (req.error) { setError(req.error); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/admin/filespaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { setError(body.error || `Could not make the drive (HTTP ${r.status}).`); return; }
      onCreated?.(body.filespace);
    } catch {
      setError('Could not reach the server. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New drive"
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form={id} className="btn btn-primary" disabled={busy}>{busy ? 'Making…' : 'Make drive'}</button>
        </>
      )}
    >
      <form id={id} className="stack" onSubmit={submit} noValidate>
        <p className="small muted" style={{ margin: 0 }}>
          A drive is a space of its own, like a disk: its own folders, its own members, and its own volume when mounted with the desktop app.
        </p>
        <label className="stack" style={{ gap: 'var(--s1)' }}>
          <span className="small">Name</span>
          <input ref={nameRef} className="input" value={form.name} maxLength={80} placeholder="Brand assets" onChange={set('name')} />
        </label>
        <label className="stack" style={{ gap: 'var(--s1)' }}>
          <span className="small">Folder in the bucket <span className="muted">(set once)</span></span>
          <input
            className="input mono"
            value={shownPrefix}
            placeholder="brand-assets"
            onChange={(e) => { setError(null); setForm((f) => ({ ...f, prefix: e.target.value, prefixTouched: true })); }}
          />
        </label>
        <details className="new-drive-advanced">
          <summary className="small">Advanced: another bucket or its own keys</summary>
          <div className="stack" style={{ marginTop: 'var(--s3)' }}>
            <p className="small muted" style={{ margin: 0 }}>Leave these blank to use the Storage settings.</p>
            <Field label="Bucket" hint="Blank uses the Storage bucket.">
              <input className="input mono" value={form.bucket} onChange={set('bucket')} autoComplete="off" />
            </Field>
            <Field label="Region">
              <input className="input mono" value={form.region} onChange={set('region')} placeholder="us-east-1" autoComplete="off" />
            </Field>
            <Field label="Role to assume (ARN)" hint="AWS only. Desktop credentials for this drive are minted by assuming this role.">
              <input className="input mono" value={form.roleArn} onChange={set('roleArn')} autoComplete="off" />
            </Field>
            <Field label="Access key ID" hint="Only for a bucket with keys of its own. Give the secret too.">
              <input className="input mono" value={form.accessKeyId} onChange={set('accessKeyId')} autoComplete="off" />
            </Field>
            <Field label="Secret access key">
              <input className="input mono" type="password" value={form.secretAccessKey} onChange={set('secretAccessKey')} autoComplete="new-password" />
            </Field>
            <Field label="Endpoint" hint="With its own keys, for a service other than AWS. Blank for AWS.">
              <input className="input mono" value={form.endpoint} onChange={set('endpoint')} placeholder="https://…" autoComplete="off" />
            </Field>
          </div>
        </details>
        {error && <p className="small" role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p>}
      </form>
    </Dialog>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="stack" style={{ gap: 'var(--s1)' }}>
      <span className="small">{label}</span>
      {children}
      {hint && <span className="small muted">{hint}</span>}
    </label>
  );
}
