'use client';

import { useCallback, useEffect, useState } from 'react';
import { STORAGE_PRESETS, presetById, detectPreset, applyPreset, summarizeChecks } from '@/lib/storage-presets';
import FilespaceMembers from '@/app/components/FilespaceMembers';
import { useConfirm } from '@/app/components/ui/Confirm';
import { fmtSize } from '@/app/components/ui/FileCard';

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

export default function AdminClient({ superAdmin, initialTab }) {
  // ?tab= lets the files UI's "Manage filespaces…" land on the right tab.
  const [tab, setTab] = useState(TABS.some((t) => t.key === initialTab) ? initialTab : 'storage');
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

/**
 * The diagnostics read-out.
 *
 * Every failing check carries its own fix, because the provider's own error
 * text ("AccessDenied") tells an admin nothing about which of six settings
 * is wrong.
 */
function Diagnostics({ result, dirty }) {
  const summary = summarizeChecks(result.checks);
  const colour = { pass: 'var(--muted)', warn: 'var(--warning)', fail: 'var(--danger)' };
  const glyph = { pass: '✓', warn: '!', fail: '✗' };

  return (
    <Panel
      title={`Diagnostics · ${result.label}`}
      hint={dirty ? `${summary.label} Run against the unsaved form above.` : summary.label}
    >
      {result.checks.map((c) => (
        <div key={c.id} style={{ display: 'flex', gap: 10, padding: '10px 0', borderTop: '1px solid var(--line)' }}>
          <span aria-hidden style={{ color: colour[c.status], fontWeight: 600, width: 12 }}>{glyph[c.status]}</span>
          <div style={{ minWidth: 0 }}>
            <div className="small" style={{ fontWeight: 500 }}>
              {c.label}
              <span className="sr-only">{` — ${c.status}`}</span>
            </div>
            {c.detail && <div className="muted small" style={{ marginTop: 2 }}>{c.detail}</div>}
            {c.fix && <div className="small" style={{ marginTop: 4, color: colour[c.status] }}>{c.fix}</div>}
          </div>
        </div>
      ))}
    </Panel>
  );
}

// ── Filespaces ──────────────────────────────────────────────────────────────

function FilespacesTab() {
  const { data, error, reload, setError } = useResource('/api/admin/filespaces');
  const [draft, setDraft] = useState({ name: '', bucket: '', prefix: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const { confirm, confirmElement } = useConfirm();

  const create = async (e) => {
    e.preventDefault();
    setError(null); setMsg(null); setBusy(true);
    try {
      const out = await api('/api/admin/filespaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) });
      setDraft({ name: '', bucket: '', prefix: '' });
      setMsg(`Created ${out.filespace?.name || 'the filespace'}. Add its members below.`);
      reload();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const remove = async (fs) => {
    setError(null); setMsg(null);
    let s;
    try {
      s = await api(`/api/admin/filespaces?summary=${encodeURIComponent(fs.id)}`);
    } catch (err) { setError(err.message); return; }
    const where = `${s.bucket}/${s.prefix}`;
    const files = s.files === 1 ? '1 file' : `${s.files.toLocaleString()} files`;
    const members = s.members === 1 ? '1 member loses' : `${s.members} members lose`;
    const ok = await confirm({
      title: `Delete filespace "${fs.name}"?`,
      body: (
        <>
          This removes the filespace and its access list: {members} it in the switcher and the desktop app, and existing
          desktop mounts stop when their credentials next refresh (within an hour).
          <br /><br />
          <strong>Nothing in storage is deleted.</strong>{' '}
          {s.files > 0
            ? <>The {files} ({fmtSize(s.bytes) || '0 B'}) under <span className="mono">{where}</span> stay in the bucket and in the library, where admins still find them under All files.</>
            : <>Nothing is catalogued under <span className="mono">{where}</span>.</>}
          {' '}The bucket itself is untouched.
          {s.ownKeys ? ' The access keys stored for this filespace are forgotten.' : ''}
        </>
      ),
      confirmLabel: 'Delete filespace',
    });
    if (!ok) return;
    try {
      await api(`/api/admin/filespaces?id=${encodeURIComponent(fs.id)}`, { method: 'DELETE' });
      setMsg(`Deleted ${fs.name}. ${files} kept in storage.`);
      reload();
    } catch (err) { setError(err.message); }
  };

  return (
    <>
      <Panel
        title="New filespace"
        hint="A filespace is a named bucket+prefix scope. People are granted access to one, and the desktop app mounts exactly that scope — nothing above it."
      >
        <form onSubmit={create}>
          <Field label="Name"><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
          <Field label="Bucket" hint="Leave blank to use the Storage bucket.">
            <input className="input" value={draft.bucket} onChange={(e) => setDraft({ ...draft, bucket: e.target.value })} />
          </Field>
          <Field label="Prefix" hint="The scope. Credentials minted for this filespace can reach nothing outside it.">
            <input className="input" value={draft.prefix} onChange={(e) => setDraft({ ...draft, prefix: e.target.value })} placeholder="projects/acme" />
          </Field>
          <button className="btn btn-primary" type="submit" disabled={busy || !draft.name.trim() || !draft.prefix.trim()}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </form>
        <Status error={error} ok={msg} />
      </Panel>

      {data && !(data.filespaces || []).length && <p className="muted small">No filespaces yet.</p>}
      {(data?.filespaces || []).map((fs) => (
        <FilespaceCard key={fs.id} fs={fs} onChanged={reload} onDelete={() => remove(fs)} />
      ))}
      {confirmElement}
    </>
  );
}

/**
 * One filespace: rename in place, delete, open in Files, and its members.
 * Rename is metadata only — the prefix, and so every stored object, stays put.
 */
function FilespaceCard({ fs, onChanged, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(fs.name);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    const next = name.trim();
    if (!next || next === fs.name) { setEditing(false); setName(fs.name); return; }
    setBusy(true); setError(null);
    try {
      await api('/api/admin/filespaces', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: fs.id, name: next }) });
      setEditing(false);
      onChanged();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <section className="card" style={{ padding: 20, marginBottom: 16 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        {editing ? (
          <form className="row" style={{ gap: 8, flex: '1 1 260px' }} onSubmit={save}>
            <input
              className="input"
              aria-label="Filespace name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { setEditing(false); setName(fs.name); setError(null); } }}
            />
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            <button className="btn btn-sm" type="button" onClick={() => { setEditing(false); setName(fs.name); setError(null); }}>Cancel</button>
          </form>
        ) : (
          <>
            <h2 style={{ fontSize: 16, margin: 0 }}>{fs.name}</h2>
            <div className="spacer" />
            <a className="btn btn-ghost btn-sm" href={`/files?filespace=${encodeURIComponent(fs.id)}`}>Open in Files</a>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>Rename</button>
            <button className="btn btn-ghost btn-sm" style={{ color: 'var(--danger)' }} onClick={onDelete}>Delete…</button>
          </>
        )}
      </div>
      <p className="muted small mono" style={{ margin: '0 0 14px' }}>{fs.bucket || '(default bucket)'} / {fs.prefix || ''}</p>
      {error && <p className="small" role="alert" style={{ color: 'var(--danger)', margin: '0 0 12px' }}>{error}</p>}
      <FilespaceMembers filespaceId={fs.id} onChanged={onChanged} />
    </section>
  );
}

// ── Access ──────────────────────────────────────────────────────────────────

function AccessTab() {
  const { data, error, reload, setError } = useResource('/api/admin/invites');
  const [email, setEmail] = useState('');

  const act = async (fn) => {
    setError(null);
    try { await fn(); reload(); } catch (e) { setError(e.message); }
  };

  return (
    <Panel
      title="Who can sign in"
      hint="Onyx is invite-only. Revoking removes the invite row and deletes the auth account, which signs out any live browser session; desktop tokens stop within one request because the allowlist is re-checked on every call."
    >
      <div className="row" style={{ marginBottom: 16 }}>
        <input className="input" style={{ maxWidth: 280 }} placeholder="someone@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button
          className="btn btn-primary"
          disabled={!email.includes('@')}
          onClick={() => act(async () => {
            await api('/api/admin/invites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
            setEmail('');
          })}
        >
          Add
        </button>
      </div>

      <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
        <tbody>
          {(data?.requests || []).map((r) => (
            <tr key={r.id} style={{ borderTop: '1px solid var(--line)' }}>
              <td style={{ padding: '6px 0' }}>{r.email}</td>
              <td className="muted">{r.name}</td>
              <td><span className="tag">{r.status}</span></td>
              <td style={{ textAlign: 'right' }}>
                {r.status !== 'approved' && (
                  <button
                    className="small"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', marginRight: 10 }}
                    onClick={() => act(() => api('/api/admin/invites', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: r.id, status: 'approved' }) }))}
                  >
                    approve
                  </button>
                )}
                <button
                  className="small"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', color: 'var(--danger)' }}
                  onClick={() => confirm(`Revoke access for ${r.email}?`) && act(() => api(`/api/admin/invites?email=${encodeURIComponent(r.email)}`, { method: 'DELETE' }))}
                >
                  revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Status error={error} />
    </Panel>
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
