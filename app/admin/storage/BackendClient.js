'use client';

import { useEffect, useState } from 'react';
import {
  STORAGE_PRESETS, presetById, detectPreset, applyPreset, summarizeChecks, moveNeedsConfirm, moveWarning,
} from '@/lib/storage-presets';
import { plural } from '@/lib/admin-format';
import { useToast } from '@/app/components/ui/Toast';
import AdminPage, { AdminCard } from '../_ui/AdminPage';
import AdminState from '../_ui/AdminState';
import CheckList from '../_ui/CheckList';
import CopyButton from '../_ui/CopyButton';
import { useDestructiveConfirm } from '../_ui/DestructiveConfirm';
import { api, useAdminResource } from '../_ui/api';

// The fields the form edits. The secret is never sent to the browser, so
// it is not compared: blank means "keep the stored one".
const FIELDS = ['provider', 'bucket', 'region', 'endpoint', 'accessKeyId', 'prefix', 'roleArn', 'publicBaseUrl', 'accelerate'];
const norm = (k, v) => (k === 'accelerate' ? !!v : String(v ?? '').trim());

/**
 * Admin → Storage → Backend: where the library's files are kept.
 *
 * A save that would repoint the library — another provider, bucket or
 * service — while files are stored asks first (moveNeedsConfirm), and the
 * server refuses it with 409 unless confirmed, for anything that did not
 * ask. "Test and save" connects before it saves (PUT with test: true).
 */
export default function BackendClient() {
  const res = useAdminResource('/api/admin/storage');
  const toast = useToast();
  const { confirm, confirmElement } = useDestructiveConfirm();
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [diag, setDiag] = useState(null);
  const [cors, setCors] = useState(null);

  const saved = res.data?.config || null;
  useEffect(() => { if (saved) setForm({ ...saved, secretAccessKey: '' }); }, [saved]);

  if (!form) {
    return (
      <AdminPage title="Backend" description="Where the library’s files are kept, and the keys that reach them.">
        {res.error
          ? <AdminState kind="error" title="The storage settings could not be loaded." error={res.error} onRetry={res.reload} retrying={res.loading} />
          : <AdminState kind="loading" rows={6} />}
      </AdminPage>
    );
  }

  const s3 = form.provider === 's3';
  const preset = presetById(detectPreset(form.endpoint)) || presetById('other');
  const aws = s3 && preset.id === 'aws';
  const files = Number(res.data?.library?.files) || 0;
  const dirty = FIELDS.some((k) => norm(k, form[k]) !== norm(k, saved?.[k])) || !!form.secretAccessKey;

  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setSaveError(null);
    setForm((f) => ({ ...f, [k]: v }));
  };

  const save = async ({ test, confirmMove = false } = {}) => {
    if (busy) return;
    // Ask before repointing the library; the server asks too (409).
    if (!confirmMove && moveNeedsConfirm(saved, form, files)) {
      const w = moveWarning(saved, form, files);
      if (!(await confirm(w))) return;
      confirmMove = true;
    }
    setBusy(test ? 'test-save' : 'save');
    setSaveError(null);
    try {
      const out = await api('/api/admin/storage', { method: 'PUT', json: { config: form, test: !!test, confirmMove } });
      // Take the saved config from the answer: a follow-up GET can reach an
      // instance whose settings cache has not seen the write yet.
      res.setData({ ...res.data, config: out.config });
      setDiag(null);
      toast.success(out.tested ? 'Connected, and saved.' : 'Saved.');
    } catch (e) {
      if (e.status === 409 && e.body?.code === 'confirm_move' && !confirmMove) {
        setBusy(null);
        const ok = await confirm({ title: 'Change where files are kept?', body: e.message, confirmLabel: 'Change it anyway' });
        if (ok) return save({ test, confirmMove: true });
        return;
      }
      setSaveError({ message: e.message, testFailed: !!test && e.status === 400 && /^Connection test failed/.test(e.message) });
    } finally {
      setBusy(null);
    }
  };

  const diagnose = async () => {
    setBusy('diagnose'); setDiag(null);
    try {
      setDiag({ ...(await api('/api/admin/storage/test', { method: 'POST', json: { config: form } })), draft: dirty });
    } catch (e) {
      setDiag({ error: e.message });
    } finally {
      setBusy(null);
    }
  };

  const applyCors = async () => {
    setBusy('cors'); setCors(null);
    try {
      const out = await api('/api/admin/storage/cors', { method: 'POST', json: {} });
      setCors({ ok: true, origins: out.origins || [] });
    } catch (e) {
      setCors({ error: e.message, rule: e.body?.manualRule || null });
    } finally {
      setBusy(null);
    }
  };

  const inUse = saved?.mode === 's3'
    ? <>Files are kept in the bucket <span className="admin-mono">{saved.bucket}</span>{saved.prefix ? <> under <span className="admin-mono">{saved.prefix}/</span></> : null}.</>
    : <>Files are kept in Vercel Blob.</>;

  return (
    <AdminPage
      title="Backend"
      description="Where the library’s files are kept, and the keys that reach them. Drives and the desktop app need an S3-compatible bucket."
    >
      <AdminCard
        title="Where files are kept"
        id="backend"
        actions={dirty ? <span className="tag tag-warning">Unsaved changes</span> : null}
      >
        <p className="small admin-hint-flat">
          {inUse} {files > 0 ? `The library holds ${plural(files, 'file')}.` : 'Nothing is stored yet.'}
        </p>
        <form className="admin-form" onSubmit={(e) => { e.preventDefault(); save({ test: s3 }); }} noValidate>
          <div className="admin-form-grid">
            <label className="admin-field">
              <span className="admin-field-label">Storage</span>
              <select className="input" value={s3 ? 's3' : 'blob'} onChange={set('provider')}>
                <option value="blob">Vercel Blob (built in)</option>
                <option value="s3">An S3-compatible bucket</option>
              </select>
            </label>
            {s3 && (
              <label className="admin-field">
                <span className="admin-field-label">Service</span>
                <select className="input" value={preset.id} onChange={(e) => { setSaveError(null); setForm(applyPreset(form, e.target.value)); }}>
                  {STORAGE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </label>
            )}
          </div>
          <p className="admin-field-hint">
            {s3
              ? `${preset.note} Choosing a service fills in its address and region; anything already typed is kept.`
              : 'Blob needs no setup, but drives and the desktop app can’t use it: they need an S3-compatible bucket.'}
          </p>

          {s3 && (
            <>
              <div className="admin-form-grid">
                <label className="admin-field">
                  <span className="admin-field-label">Bucket</span>
                  <input className="input mono" value={form.bucket || ''} onChange={set('bucket')} autoComplete="off" />
                </label>
                <label className="admin-field">
                  <span className="admin-field-label">Region</span>
                  <input className="input mono" value={form.region || ''} onChange={set('region')} placeholder={preset.regionPlaceholder} autoComplete="off" />
                </label>
                <label className="admin-field">
                  <span className="admin-field-label">Service address (endpoint)</span>
                  <input className="input mono" value={form.endpoint || ''} onChange={set('endpoint')} placeholder={aws ? 'Blank for Amazon S3' : 'https://…'} autoComplete="off" />
                  <span className="admin-field-hint">Blank for Amazon S3.</span>
                </label>
                <label className="admin-field">
                  <span className="admin-field-label">Folder for files</span>
                  <input className="input mono" value={form.prefix || ''} onChange={set('prefix')} placeholder="files" autoComplete="off" />
                  <span className="admin-field-hint">Uploads outside a drive go under this folder in the bucket.</span>
                </label>
                <label className="admin-field">
                  <span className="admin-field-label">Access key ID</span>
                  <input className="input mono" value={form.accessKeyId || ''} onChange={set('accessKeyId')} autoComplete="off" />
                </label>
                <label className="admin-field">
                  <span className="admin-field-label">Secret access key</span>
                  <input
                    className="input mono" type="password" value={form.secretAccessKey || ''} onChange={set('secretAccessKey')}
                    placeholder={saved?.hasSecret ? '••••••••••••' : ''} autoComplete="new-password"
                  />
                  <span className="admin-field-hint">{saved?.hasSecret ? 'A secret is stored. Leave blank to keep it.' : 'Kept on the server and never shown again.'}</span>
                </label>
              </div>

              <Disclosure summary="More options" initiallyOpen={!!(saved?.roleArn || saved?.publicBaseUrl || saved?.accelerate)}>
                <div className="admin-form">
                  {aws && (
                    <label className="admin-field">
                      <span className="admin-field-label">Role to assume (ARN)</span>
                      <input className="input mono" value={form.roleArn || ''} onChange={set('roleArn')} autoComplete="off" />
                      <span className="admin-field-hint">Optional. With a role, desktop credentials come from assuming it rather than from the keys above.</span>
                    </label>
                  )}
                  <label className="admin-field">
                    <span className="admin-field-label">Public address</span>
                    <input className="input mono" value={form.publicBaseUrl || ''} onChange={set('publicBaseUrl')} placeholder="https://cdn.example.com" autoComplete="off" />
                    <span className="admin-field-hint">
                      Optional: a CDN or public domain in front of the bucket. Files are then linked through it without signed links, so anyone with a file’s link can open it. Leave blank to keep links signed and short-lived.
                    </span>
                  </label>
                  {aws && !String(form.endpoint || '').trim() && (
                    <label className="admin-check">
                      <input type="checkbox" checked={!!form.accelerate} onChange={set('accelerate')} />
                      <span>
                        <span className="admin-field-label">Faster uploads from far away (Transfer Acceleration)</span>
                        <span className="admin-field-hint">Amazon S3 only, at extra cost. Switched on at the bucket when you save; the keys need s3:PutAccelerateConfiguration.</span>
                      </span>
                    </label>
                  )}
                </div>
              </Disclosure>
            </>
          )}

          {saveError && (
            <div className="admin-error card" role="alert">
              <p className="admin-error-text small">{saveError.message}</p>
              {saveError.testFailed && (
                <div className="admin-error-action">
                  <button type="button" className="btn btn-sm" onClick={() => save({ test: false })} disabled={!!busy}>Save without testing</button>
                </div>
              )}
            </div>
          )}

          <div className="admin-form-actions">
            <button type="submit" className="btn btn-primary" disabled={!!busy || !dirty}>
              {busy === 'test-save' ? 'Testing…' : busy === 'save' ? 'Saving…' : s3 ? 'Test and save' : 'Save'}
            </button>
            {s3 && (
              <button type="button" className="btn" onClick={diagnose} disabled={!!busy}>
                {busy === 'diagnose' ? 'Checking…' : 'Run diagnostics'}
              </button>
            )}
          </div>
        </form>
      </AdminCard>

      {diag && (
        <AdminCard title="Diagnostics" id="diagnostics" actions={diag.checks ? <DiagTag checks={diag.checks} /> : null}>
          {diag.error
            ? <p className="small admin-inline-error" role="alert">{diag.error}</p>
            : (
              <>
                {diag.draft && <p className="small muted admin-hint-flat">Run against the form as it is now, not what is saved.</p>}
                <CheckList checks={diag.checks} label="Storage diagnostics" />
              </>
            )}
        </AdminCard>
      )}

      {saved?.mode === 's3' && (
        <AdminCard title="Browser uploads" id="cors">
          <p className="small admin-hint-flat">
            Browsers upload straight to the bucket, so the bucket has to allow this site. Apply CORS sets a rule allowing uploads from{' '}
            {(res.data?.corsOrigins || []).length
              ? (res.data.corsOrigins.map((o, i) => <span key={o}>{i ? ', ' : ''}<span className="admin-mono">{o}</span></span>))
              : 'this site'}.
          </p>
          <div className="admin-form-actions">
            <button type="button" className="btn" onClick={applyCors} disabled={!!busy}>{busy === 'cors' ? 'Applying…' : 'Apply CORS'}</button>
            {cors?.ok && <span className="small muted" role="status">Applied for {cors.origins.join(', ')}.</span>}
          </div>
          {cors?.error && (
            <div className="admin-error card is-inline" role="alert">
              <p className="admin-error-text small">{cors.error}</p>
              {cors.rule && (
                <>
                  <p className="small muted admin-note">Paste this rule into the bucket’s CORS settings in the provider’s console instead:</p>
                  <pre className="admin-pre mono small">{JSON.stringify(cors.rule, null, 2)}</pre>
                  <div className="admin-copy-row">
                    <span className="small muted">JSON, as S3-compatible consoles take it.</span>
                    <CopyButton text={JSON.stringify(cors.rule, null, 2)} label="Copy rule" />
                  </div>
                </>
              )}
            </div>
          )}
        </AdminCard>
      )}
      {confirmElement}
    </AdminPage>
  );
}

/** A <details> that starts open when it holds something set, and then is the reader's to open and shut. */
function Disclosure({ summary, initiallyOpen, children }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <details className="admin-disclosure" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{summary}</summary>
      {children}
    </details>
  );
}

function DiagTag({ checks }) {
  const s = summarizeChecks(checks);
  return <span className={`tag ${s.failed ? 'tag-danger' : s.warned ? 'tag-warning' : 'tag-accent'}`}>{s.label}</span>;
}
