'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Dialog from '@/app/components/ui/Dialog';
import { drivePrefixFor } from '@/lib/folder-ops';
import { newDriveRequest } from '@/lib/admin-drives';
import DriveLocationFields from './DriveLocationFields';

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
 * its own. Left alone, the drive uses the Storage settings. Its fields are
 * the drive drawer's (DriveLocationFields), in the same order and words.
 */
export default function NewDriveDialog({ open, onClose, onCreated, storage = {} }) {
  const [form, setForm] = useState(BLANK);
  const [ownKeys, setOwnKeys] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const nameRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setForm(BLANK); setOwnKeys(false); setError(null); setBusy(false);
    nameRef.current?.focus();
  }, [open]);

  const set = (k) => (e) => { setError(null); setForm((f) => ({ ...f, [k]: e.target.value })); };
  const toggleKeys = (on) => {
    setError(null);
    setOwnKeys(on);
    // Off, it uses the Storage keys: nothing typed for its own is sent.
    if (!on) setForm((f) => ({ ...f, accessKeyId: '', secretAccessKey: '', endpoint: '' }));
  };
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
      <form id={id} className="admin-form" onSubmit={submit} noValidate>
        <p className="small muted admin-note">
          A drive is a space of its own, like a disk: its own folders, its own members, and its own volume when mounted with the desktop app.
        </p>
        <label className="admin-field">
          <span className="admin-field-label">Name</span>
          <input ref={nameRef} className="input" value={form.name} maxLength={80} placeholder="Brand assets" onChange={set('name')} />
        </label>
        <label className="admin-field">
          <span className="admin-field-label">Folder in the bucket</span>
          <input
            className="input mono"
            value={shownPrefix}
            placeholder="brand-assets"
            autoComplete="off"
            onChange={(e) => { setError(null); setForm((f) => ({ ...f, prefix: e.target.value, prefixTouched: true })); }}
          />
          <span className="admin-field-hint">Set once: it is fixed while the drive holds files.</span>
        </label>
        <details className="admin-disclosure">
          <summary>Advanced: another bucket or its own keys</summary>
          <div className="admin-form">
            <p className="small muted admin-note">Leave these blank to use the Storage settings.</p>
            <DriveLocationFields
              form={form}
              onField={set}
              ownKeys={ownKeys}
              onOwnKeys={toggleKeys}
              storage={storage}
              mode="new"
            />
          </div>
        </details>
        {error && <p className="small admin-inline-error" role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
