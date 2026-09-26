'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { fmtSize } from '@/lib/media';
import { plural } from '@/lib/admin-format';
import { driveSettingsPatch } from '@/lib/admin-drives';
import { summarizeChecks } from '@/lib/storage-presets';
import FilespaceMembers from '@/app/components/FilespaceMembers';
import { useDeleteDrive } from '@/app/components/drives/DeleteDriveConfirm';
import { useToast } from '@/app/components/ui/Toast';
import RouteDrawer from '../../_ui/RouteDrawer';
import { DrawerSection } from '../../_ui/Drawer';
import CheckList from '../../_ui/CheckList';
import KindBreakdown from '../../_ui/KindBreakdown';
import { api } from '../../_ui/api';

const size = (n) => fmtSize(n) || '0 B';

const SECTIONS = [
  { id: 'members', label: 'Members' },
  { id: 'settings', label: 'Settings' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'usage', label: 'Usage' },
  { id: 'danger', label: 'Delete' },
];

/**
 * One drive, in the drawer over Admin → Drives: the editor that the files
 * page's "Bucket and keys…" opens.
 *
 * `drive` is publicDrive(): never the secret, only whether one is stored.
 * `stored` is what is catalogued under its folder, which decides whether
 * the bucket and folder may still change (the API refuses it too).
 */
export default function DriveDrawer({ drive, stored, kinds, storage }) {
  const router = useRouter();
  const toast = useToast();
  const { deleteDrive, deleteElement } = useDeleteDrive();

  const remove = async () => {
    const done = await deleteDrive(drive);
    if (!done) return;
    toast.success(`Deleted the drive “${drive.name}”.`);
    router.push('/admin/drives', { scroll: false });
    router.refresh();
  };

  const where = `${drive.bucket || storage.bucket || '?'} / ${drive.prefix}`;
  return (
    <RouteDrawer
      back="/admin/drives"
      title={drive.name}
      sections={SECTIONS}
      subtitle={(
        <span className="drawer-sub-line">
          <span className="admin-mono">{where}</span>
          {drive.accessKeyId && drive.hasSecret && <span className="tag tag-accent">Own keys</span>}
          <Link href={`/files?filespace=${encodeURIComponent(drive.id)}`} className="info-link">Open in Files</Link>
        </span>
      )}
    >
      <DrawerSection id="members" title="Members">
        <p className="small muted admin-hint-flat">Admins reach every drive without being listed here.</p>
        <FilespaceMembers filespaceId={drive.id} onChanged={() => router.refresh()} />
      </DrawerSection>

      <DrawerSection id="settings" title="Settings">
        {/* Remounted after a save, so the form starts from what was stored. */}
        <DriveSettings key={drive.updatedAt || 0} drive={drive} stored={stored} storage={storage} />
      </DrawerSection>

      <DrawerSection id="diagnostics" title="Diagnostics">
        <Diagnostics driveId={drive.id} />
      </DrawerSection>

      <DrawerSection id="usage" title="Usage">
        <p className="small admin-hint-flat">
          <strong>{size(stored.bytes)}</strong> <span className="muted">in {plural(stored.files, 'file')}</span>
        </p>
        <KindBreakdown rows={kinds} total={stored.bytes} label={`${drive.name} by type`} />
      </DrawerSection>

      <DrawerSection id="danger" title="Delete this drive" tone="danger">
        <p className="small muted admin-hint-flat">
          Its members lose it and its files lose the drive around them. The files themselves stay in storage; you will see exactly what happens before anything does.
        </p>
        <button type="button" className="btn btn-danger" onClick={remove}>Delete drive…</button>
      </DrawerSection>
      {deleteElement}
    </RouteDrawer>
  );
}

/**
 * Name, where the drive lives, and its own keys. Only what changed is sent
 * (driveSettingsPatch), and a blank secret keeps the stored one.
 */
function DriveSettings({ drive, stored, storage }) {
  const router = useRouter();
  const toast = useToast();
  const saved = {
    name: drive.name, bucket: drive.bucket, prefix: drive.prefix, region: drive.region,
    endpoint: drive.endpoint, roleArn: drive.roleArn, accessKeyId: drive.accessKeyId,
  };
  const [form, setForm] = useState({ ...saved, secretAccessKey: '' });
  const [ownKeys, setOwnKeys] = useState(!!drive.accessKeyId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const locked = stored.files > 0;
  const set = (k) => (e) => { setError(null); setForm((f) => ({ ...f, [k]: e.target.value })); };
  const patch = driveSettingsPatch(saved, form);
  const dirty = Object.keys(patch).length > 0;

  const toggleKeys = (on) => {
    setError(null);
    setOwnKeys(on);
    // Turning its own keys off goes back to the Storage keys: the stored key,
    // its secret and the endpoint that went with them are cleared on save.
    if (!on) setForm((f) => ({ ...f, accessKeyId: '', secretAccessKey: '', endpoint: '' }));
    else setForm((f) => ({ ...f, accessKeyId: saved.accessKeyId || '', endpoint: saved.endpoint || '' }));
  };

  const save = async (e) => {
    e.preventDefault();
    if (!dirty || busy) return;
    if (!String(form.name || '').trim()) { setError('Give the drive a name.'); return; }
    if (ownKeys && !String(form.accessKeyId || '').trim()) { setError('Enter its access key ID, or turn off its own keys to use the Storage keys.'); return; }
    if (ownKeys && !drive.hasSecret && !String(form.secretAccessKey || '').trim()) { setError('Enter the secret access key that goes with the key ID.'); return; }
    setBusy(true); setError(null);
    try {
      await api('/api/admin/filespaces', { method: 'PATCH', json: { id: drive.id, ...patch } });
      toast.success('Saved.');
      router.refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="admin-form" onSubmit={save} noValidate>
      <label className="admin-field">
        <span className="admin-field-label">Name</span>
        <input className="input" value={form.name} maxLength={80} onChange={set('name')} />
      </label>

      {locked && (
        <p className="admin-lock" id="drive-lock">
          <svg aria-hidden viewBox="0 0 16 16" width="14" height="14"><rect x="3.5" y="7" width="9" height="6.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
          <span>
            Where it lives is fixed while it holds files: {plural(stored.files, 'file')} {stored.files === 1 ? 'is' : 'are'} stored
            under <span className="admin-mono">{drive.bucket}/{drive.prefix}</span>, and pointing the drive elsewhere would strand them.
            An empty drive can be moved.
          </span>
        </p>
      )}
      <div className="admin-form-grid">
        <label className="admin-field">
          <span className="admin-field-label">Bucket</span>
          <input
            className="input mono" value={form.bucket || ''} onChange={set('bucket')} disabled={locked}
            placeholder={storage.bucket || ''} aria-describedby={locked ? 'drive-lock' : undefined} autoComplete="off"
          />
          {!locked && storage.bucket && form.bucket === storage.bucket && !ownKeys && (
            <span className="admin-field-hint">The Storage bucket.</span>
          )}
        </label>
        <label className="admin-field">
          <span className="admin-field-label">Folder in the bucket</span>
          <input
            className="input mono" value={form.prefix || ''} onChange={set('prefix')} disabled={locked}
            aria-describedby={locked ? 'drive-lock' : undefined} autoComplete="off"
          />
        </label>
        <label className="admin-field">
          <span className="admin-field-label">Region</span>
          <input className="input mono" value={form.region || ''} onChange={set('region')} placeholder={storage.region || 'us-east-1'} autoComplete="off" />
          <span className="admin-field-hint">Blank uses the Storage region.</span>
        </label>
        {!ownKeys && (
          <label className="admin-field">
            <span className="admin-field-label">Role to assume (ARN)</span>
            <input className="input mono" value={form.roleArn || ''} onChange={set('roleArn')} autoComplete="off" />
            <span className="admin-field-hint">AWS only. Desktop credentials for this drive come from assuming it.</span>
          </label>
        )}
      </div>

      <label className="admin-check">
        <input type="checkbox" checked={ownKeys} onChange={(e) => toggleKeys(e.target.checked)} />
        <span>
          <span className="admin-field-label">Its own access keys</span>
          <span className="admin-field-hint">For a bucket apart from Storage, on another account or service. Off, it uses the Storage keys.</span>
        </span>
      </label>
      {ownKeys && (
        <div className="admin-form-grid">
          <label className="admin-field">
            <span className="admin-field-label">Access key ID</span>
            <input className="input mono" value={form.accessKeyId || ''} onChange={set('accessKeyId')} autoComplete="off" />
          </label>
          <label className="admin-field">
            <span className="admin-field-label">Secret access key</span>
            <input
              className="input mono" type="password" value={form.secretAccessKey} onChange={set('secretAccessKey')}
              placeholder={drive.hasSecret ? '••••••••••••' : ''} autoComplete="new-password"
            />
            <span className="admin-field-hint">
              {drive.hasSecret ? 'A secret is stored. Leave blank to keep it.' : 'Stored on the server and never shown again.'}
            </span>
          </label>
          <label className="admin-field">
            <span className="admin-field-label">Endpoint</span>
            <input className="input mono" value={form.endpoint || ''} onChange={set('endpoint')} placeholder="https://…" autoComplete="off" />
            <span className="admin-field-hint">Blank for AWS.</span>
          </label>
        </div>
      )}

      {error && <p className="small admin-inline-error" role="alert">{error}</p>}
      <div className="admin-form-actions">
        <button type="submit" className="btn btn-primary" disabled={!dirty || busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        {dirty && <span className="tag tag-warning">Unsaved changes</span>}
      </div>
    </form>
  );
}

/** The storage checks for this drive as saved (POST …/diagnostics). */
function Diagnostics({ driveId }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true); setError(null);
    try {
      setResult(await api(`/api/admin/filespaces/${encodeURIComponent(driveId)}/diagnostics`, { method: 'POST', json: {} }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const summary = result ? summarizeChecks(result.checks) : null;
  return (
    <div className="stack">
      <p className="small muted admin-note">
        Checks the saved settings against the bucket: that it answers, that the keys can read and write under this drive’s folder (a small test file, removed straight away), and that browsers may upload to it.
      </p>
      <div className="admin-form-actions">
        <button type="button" className="btn" onClick={run} disabled={busy}>{busy ? 'Checking…' : result ? 'Run again' : 'Run diagnostics'}</button>
        {summary && <span className={`tag ${summary.failed ? 'tag-danger' : summary.warned ? 'tag-warning' : 'tag-accent'}`}>{summary.label}</span>}
      </div>
      {error && <p className="small admin-inline-error" role="alert">{error}</p>}
      {result && <CheckList checks={result.checks} label="Drive diagnostics" />}
    </div>
  );
}
