'use client';

import { useCallback, useEffect, useState } from 'react';
import { STORAGE_PRESETS, presetById, detectPreset, applyPreset, summarizeChecks } from '@/lib/storage-presets';

// Features, Brand and Keys were editors for settings that are now compiled
// defaults. Their routes are gone; the defaults they used to override live in
// lib/features.js and lib/brand-config.js, and secrets are environment
// variables again rather than rows that could be edited from the panel they
// protect.
const TABS = [
  { key: 'storage', label: 'Storage' },
  { key: 'filespaces', label: 'Filespaces' },
  { key: 'access', label: 'Access' },
  { key: 'health', label: 'Health' },
];

async function api(url, opts) {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`);
  return body;
}

export default function AdminClient({ superAdmin }) {
  const [tab, setTab] = useState('storage');
  const tabs = TABS.filter((t) => !t.superOnly || superAdmin);

  return (
    <main className="shell" style={{ padding: '24px 24px 64px' }}>
      <h1 style={{ fontSize: 24, marginBottom: 20 }}>Admin</h1>
      <div className="row" style={{ gap: 4, marginBottom: 24, flexWrap: 'wrap' }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            className="btn"
            onClick={() => setTab(t.key)}
            style={tab === t.key ? { background: 'var(--ink)', color: 'var(--paper)', borderColor: 'var(--ink)' } : undefined}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'storage' && <StorageTab />}
      {tab === 'filespaces' && <FilespacesTab />}
      {tab === 'access' && <AccessTab />}
      {tab === 'health' && <HealthTab />}
    </main>
  );
}

// ── Shared bits ─────────────────────────────────────────────────────────────

function Panel({ title, hint, children }) {
  return (
    <section className="card" style={{ padding: 20, marginBottom: 16 }}>
      <h2 style={{ fontSize: 16, marginBottom: hint ? 4 : 14 }}>{title}</h2>
      {hint && <p className="muted small" style={{ margin: '0 0 14px' }}>{hint}</p>}
      {children}
    </section>
  );
}

function Field({ label, hint, children }) {
  return (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <div className="small" style={{ marginBottom: 4, fontWeight: 500 }}>{label}</div>
      {children}
      {hint && <div className="muted small" style={{ marginTop: 4 }}>{hint}</div>}
    </label>
  );
}

function useResource(url) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(true);
  const reload = useCallback(() => {
    setBusy(true);
    api(url).then(setData).catch((e) => setError(e.message)).finally(() => setBusy(false));
  }, [url]);
  useEffect(reload, [reload]);
  return { data, error, busy, reload, setError };
}

function Status({ error, ok }) {
  if (error) return <p className="small" style={{ color: 'var(--danger)', margin: '8px 0 0' }}>{error}</p>;
  if (ok) return <p className="small muted" style={{ margin: '8px 0 0' }}>{ok}</p>;
  return null;
}

// ── Storage ─────────────────────────────────────────────────────────────────

function StorageTab() {
  const { data, error, reload, setError } = useResource('/api/admin/storage');
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState(null);
  const [diag, setDiag] = useState(null);
  const [busy, setBusy] = useState(null);

  useEffect(() => { if (data?.config) setForm(data.config); }, [data]);
  if (!form) return <p className="muted">Loading…</p>;

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const preset = presetById(detectPreset(form.endpoint)) || presetById('other');
  // The secret never comes back from the server, so it is not comparable.
  // Everything else is, and an admin running diagnostics against a form they
  // have not saved should be told which one they are looking at.
  const dirty = Object.keys(form).some((k) => k !== 'secretAccessKey' && form[k] !== data?.config?.[k]);

  const run = async (fn, label) => {
    setBusy(label); setMsg(null); setError(null);
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(null); }
  };

  const save = () => run(async () => {
    // The server takes { config }, not the config itself. Sending the bare
    // form used to leave `body.config` undefined, so the merge kept every
    // stored value and the page said "Saved." while changing nothing.
    // Take the saved config from the response rather than re-reading it. A
    // follow-up GET can be served by a different instance whose settings
    // cache has not seen the write yet, which redisplays the old values and
    // reads as the save having silently failed.
    const out = await api('/api/admin/storage', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: form }),
    });
    if (out?.config) setForm(out.config);
    setMsg('Saved.');
    setDiag(null);
    // Refresh the baseline too, so the "unsaved changes" marker clears.
    reload();
  }, 'save');

  const diagnose = () => run(async () => {
    const out = await api('/api/admin/storage/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: form }),
    });
    setDiag(out);
  }, 'diagnose');

  const applyCors = () => run(async () => {
    const out = await api('/api/admin/storage/cors', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    setMsg(`CORS applied for ${(out.origins || []).join(', ')}.`);
    setDiag(null);
  }, 'cors');

  return (
    <>
      <Panel
        title="Backend"
        hint="Onyx falls back to Vercel Blob when no bucket is configured. Blob cannot be mounted — filespaces and the desktop app need S3."
      >
        <Field label="Provider">
          <select className="input" value={form.provider || 'blob'} onChange={set('provider')}>
            <option value="blob">Vercel Blob (no mounting)</option>
            <option value="s3">S3 or S3-compatible</option>
          </select>
        </Field>

        {form.provider === 's3' && (
          <>
            <Field label="Service" hint="Fills in the endpoint and region. Anything already typed is kept.">
              <select
                className="input"
                value={preset.id}
                onChange={(e) => setForm(applyPreset(form, e.target.value))}
              >
                {STORAGE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </Field>
            <p className="small muted" style={{ margin: '-6px 0 14px' }}>{preset.note}</p>

            <Field label="Bucket"><input className="input" value={form.bucket || ''} onChange={set('bucket')} /></Field>
            <Field label="Region" hint={`e.g. ${preset.regionPlaceholder}`}>
              <input className="input" value={form.region || ''} onChange={set('region')} placeholder={preset.regionPlaceholder} />
            </Field>
            <Field label="Endpoint" hint="Leave blank for AWS S3.">
              <input className="input" value={form.endpoint || ''} onChange={set('endpoint')} placeholder="https://…" />
            </Field>
            <Field label="Access key ID"><input className="input" value={form.accessKeyId || ''} onChange={set('accessKeyId')} /></Field>
            <Field label="Secret access key" hint={data?.config?.hasSecret ? 'A secret is stored. Leave blank to keep it.' : undefined}>
              <input className="input" type="password" value={form.secretAccessKey || ''} onChange={set('secretAccessKey')} />
            </Field>
            <Field label="Key prefix" hint="Everything Onyx writes lives under this prefix.">
              <input className="input" value={form.prefix || ''} onChange={set('prefix')} placeholder="files" />
            </Field>
            <Field label="Role ARN" hint="AWS only. With a role, desktop credentials are minted by AssumeRole instead of GetFederationToken.">
              <input className="input" value={form.roleArn || ''} onChange={set('roleArn')} />
            </Field>
          </>
        )}

        <div className="row" style={{ marginTop: 16, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={save} disabled={!!busy}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
          {form.provider === 's3' && (
            <>
              <button className="btn" onClick={diagnose} disabled={!!busy}>
                {busy === 'diagnose' ? 'Checking…' : 'Run diagnostics'}
              </button>
              <button className="btn" onClick={applyCors} disabled={!!busy}>
                {busy === 'cors' ? 'Applying…' : 'Apply CORS'}
              </button>
            </>
          )}
          {dirty && <span className="tag tag-warning">Unsaved changes</span>}
        </div>
        <Status error={error} ok={msg} />
      </Panel>

      {diag && <Diagnostics result={diag} dirty={dirty} />}

    </>
  );
}

function HealthTab() {
  const { data, error } = useResource('/api/health');
  return (
    <Panel title="Health" hint="Also reachable at /api/health when sign-in is broken, using CRON_SECRET as a bearer token.">
      {error ? (
        <Status error={error} />
      ) : (
        <pre className="small" style={{ margin: 0, overflow: 'auto' }}>{JSON.stringify(data, null, 2)}</pre>
      )}
    </Panel>
  );
}
