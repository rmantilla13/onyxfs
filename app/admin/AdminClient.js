'use client';

import { useCallback, useEffect, useState } from 'react';

const TABS = [
  { key: 'storage', label: 'Storage' },
  { key: 'filespaces', label: 'Filespaces' },
  { key: 'access', label: 'Access' },
  { key: 'features', label: 'Features' },
  { key: 'brand', label: 'Brand', superOnly: true },
  { key: 'keys', label: 'Keys', superOnly: true },
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
      {tab === 'features' && <FeaturesTab />}
      {tab === 'brand' && <BrandTab />}
      {tab === 'keys' && <KeysTab />}
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

  useEffect(() => { if (data?.config) setForm(data.config); }, [data]);
  if (!form) return <p className="muted">Loading…</p>;

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const save = async () => {
    setMsg(null); setError(null);
    try {
      await api('/api/admin/storage', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) });
      setMsg('Saved.');
      reload();
    } catch (e) { setError(e.message); }
  };

  const act = async (path, label) => {
    setMsg(null); setError(null);
    try {
      const out = await api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      setMsg(out.message || `${label} ok.`);
    } catch (e) { setError(e.message); }
  };

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
            <Field label="Bucket"><input className="input" value={form.bucket || ''} onChange={set('bucket')} /></Field>
            <Field label="Region" hint="Use 'auto' for R2."><input className="input" value={form.region || ''} onChange={set('region')} /></Field>
            <Field label="Endpoint" hint="Leave blank for AWS S3. Set it for R2, Spaces, B2, Wasabi or MinIO.">
              <input className="input" value={form.endpoint || ''} onChange={set('endpoint')} placeholder="https://…" />
            </Field>
            <Field label="Access key ID"><input className="input" value={form.accessKeyId || ''} onChange={set('accessKeyId')} /></Field>
            <Field label="Secret access key" hint={data?.config?.hasSecret ? 'A secret is stored. Leave blank to keep it.' : undefined}>
              <input className="input" type="password" value={form.secretAccessKey || ''} onChange={set('secretAccessKey')} />
            </Field>
            <Field label="Key prefix" hint="Everything Onyx writes lives under this prefix.">
              <input className="input" value={form.prefix || ''} onChange={set('prefix')} placeholder="files" />
            </Field>
            <Field label="Role ARN" hint="Optional. With a role, desktop credentials are minted by AssumeRole instead of GetFederationToken.">
              <input className="input" value={form.roleArn || ''} onChange={set('roleArn')} />
            </Field>
          </>
        )}

        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn btn-primary" onClick={save}>Save</button>
          {form.provider === 's3' && (
            <>
              <button className="btn" onClick={() => act('/api/admin/storage', 'Test')}>Test connection</button>
              <button className="btn" onClick={() => act('/api/admin/storage/cors', 'CORS')}>Apply CORS</button>
            </>
          )}
        </div>
        <Status error={error} ok={msg} />
      </Panel>

      {form.provider === 's3' && !form.endpoint && (
        <Panel title="Transfer Acceleration" hint="AWS S3 only. Needs s3:PutAccelerateConfiguration on the key.">
          <div className="row">
            <button className="btn" onClick={() => act('/api/admin/storage/accel', 'Acceleration')}>Toggle</button>
          </div>
        </Panel>
      )}
    </>
  );
}

// ── Filespaces ──────────────────────────────────────────────────────────────

function FilespacesTab() {
  const { data, error, reload, setError } = useResource('/api/admin/filespaces');
  const [draft, setDraft] = useState({ name: '', bucket: '', prefix: '', region: '' });
  const [grant, setGrant] = useState({});

  const create = async () => {
    setError(null);
    try {
      await api('/api/admin/filespaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) });
      setDraft({ name: '', bucket: '', prefix: '', region: '' });
      reload();
    } catch (e) { setError(e.message); }
  };

  const addAccess = async (id) => {
    const g = grant[id] || {};
    if (!g.email) return;
    setError(null);
    try {
      await api(`/api/admin/filespaces/${id}/access`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: g.email, role: g.role || 'viewer' }),
      });
      setGrant({ ...grant, [id]: {} });
      reload();
    } catch (e) { setError(e.message); }
  };

  return (
    <>
      <Panel
        title="New filespace"
        hint="A filespace is a named bucket+prefix scope. People are granted access to one, and the desktop app mounts exactly that scope — nothing above it."
      >
        <Field label="Name"><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
        <Field label="Bucket" hint="Leave blank to inherit the configured bucket.">
          <input className="input" value={draft.bucket} onChange={(e) => setDraft({ ...draft, bucket: e.target.value })} />
        </Field>
        <Field label="Prefix" hint="The scope. Credentials minted for this filespace can reach nothing outside it.">
          <input className="input" value={draft.prefix} onChange={(e) => setDraft({ ...draft, prefix: e.target.value })} placeholder="projects/acme" />
        </Field>
        <button className="btn btn-primary" onClick={create} disabled={!draft.name}>Create</button>
        <Status error={error} />
      </Panel>

      {(data?.filespaces || []).map((fs) => (
        <Panel key={fs.id} title={fs.name} hint={`${fs.bucket || '(default bucket)'} / ${fs.prefix || ''}`}>
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <tbody>
              {(fs.members || []).map((m) => (
                <tr key={m.email}>
                  <td style={{ padding: '4px 0' }}>{m.email}</td>
                  <td className="muted">{m.role}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="small muted"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
                      onClick={async () => {
                        await fetch(`/api/admin/filespaces/${fs.id}/access?email=${encodeURIComponent(m.email)}`, { method: 'DELETE' });
                        reload();
                      }}
                    >
                      revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 12 }}>
            <input
              className="input"
              style={{ maxWidth: 240 }}
              placeholder="someone@example.com"
              value={grant[fs.id]?.email || ''}
              onChange={(e) => setGrant({ ...grant, [fs.id]: { ...grant[fs.id], email: e.target.value } })}
            />
            <select
              className="input"
              style={{ width: 'auto' }}
              value={grant[fs.id]?.role || 'viewer'}
              onChange={(e) => setGrant({ ...grant, [fs.id]: { ...grant[fs.id], role: e.target.value } })}
            >
              <option value="viewer">viewer</option>
              <option value="editor">editor</option>
              <option value="owner">owner</option>
            </select>
            <button className="btn" onClick={() => addAccess(fs.id)}>Grant</button>
          </div>
        </Panel>
      ))}
    </>
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

// ── Features ────────────────────────────────────────────────────────────────

function FeaturesTab() {
  const { data, error, setError } = useResource('/api/admin/features');
  const [flags, setFlags] = useState(null);
  const [msg, setMsg] = useState(null);

  useEffect(() => { if (data?.flags) setFlags(data.flags); }, [data]);
  if (!flags) return <p className="muted">Loading…</p>;

  const save = async (next) => {
    setFlags(next);
    setMsg(null); setError(null);
    try {
      await api('/api/admin/features', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flags: next }) });
      setMsg('Saved.');
    } catch (e) { setError(e.message); }
  };

  const groups = {};
  for (const f of data.registry) (groups[f.category] ||= []).push(f);

  return (
    <>
      {Object.entries(groups).map(([cat, items]) => (
        <Panel key={cat} title={cat}>
          {items.map((f) => (
            <div key={f.key} style={{ padding: '10px 0', borderTop: '1px solid var(--line)' }}>
              <label className="row" style={{ alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!!flags[f.key]}
                  onChange={(e) => save({ ...flags, [f.key]: e.target.checked })}
                  style={{ marginTop: 3 }}
                />
                <span>
                  <span style={{ fontWeight: 500, fontSize: 14 }}>{f.label}</span>
                  <span className="tag" style={{ marginLeft: 8 }}>{f.enforcement}</span>
                  <div className="muted small" style={{ marginTop: 2 }}>{f.description}</div>
                </span>
              </label>
            </div>
          ))}
        </Panel>
      ))}
      <Status error={error} ok={msg} />
    </>
  );
}

// ── Brand ───────────────────────────────────────────────────────────────────

function BrandTab() {
  const { data, error, setError } = useResource('/api/admin/brand');
  const [form, setForm] = useState({});
  const [msg, setMsg] = useState(null);

  useEffect(() => { if (data?.saved) setForm(data.saved); }, [data]);
  if (!data) return <p className="muted">Loading…</p>;

  const d = data.defaults;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const save = async () => {
    setMsg(null); setError(null);
    try {
      await api('/api/admin/brand', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) });
      setMsg('Saved. Reload to see it applied.');
    } catch (e) { setError(e.message); }
  };

  const text = (k, label, hint) => (
    <Field label={label} hint={hint}>
      <input className="input" value={form[k] ?? ''} placeholder={d[k]} onChange={set(k)} />
    </Field>
  );
  const color = (k, label) => (
    <Field label={label}>
      <div className="row">
        <input type="color" value={form[k] || d[k]} onChange={set(k)} style={{ width: 44, height: 34, padding: 2 }} />
        <input className="input" value={form[k] ?? ''} placeholder={d[k]} onChange={set(k)} />
      </div>
    </Field>
  );

  return (
    <>
      <Panel title="Identity" hint="Blank means inherit the Onyx default shown as the placeholder — it does not mean empty.">
        {text('name', 'Name')}
        {text('tagline', 'Tagline')}
        {text('origin', 'Origin', 'Used for share links, the magic-link email, and the bucket CORS allowlist.')}
        {text('supportEmail', 'Support email')}
      </Panel>
      <Panel title="Palette">
        {color('colorPaper', 'Paper')}
        {color('colorInk', 'Ink')}
        {color('colorMuted', 'Muted')}
        {color('colorLine', 'Line')}
        {color('colorAccent', 'Accent')}
        {color('colorAccentDeep', 'Accent, pressed')}
      </Panel>
      <Panel title="Type & marks">
        {text('displayFontFamily', 'Display font family')}
        {text('displayFontUrl', 'Display font stylesheet URL')}
        {text('bodyFontFamily', 'Body font family')}
        {text('markUrl', 'Mark URL')}
        {text('lockupUrl', 'Lockup URL')}
      </Panel>
      <Panel title="Desktop" hint="The URL scheme is compiled into the app bundle and registered with the OS at install time, so it cannot be changed here.">
        {text('desktopProductName', 'Product name')}
        {text('mountFolder', 'Mount folder', 'The drive appears at ~/<this> when mounted.')}
        <Field label="URL scheme">
          <input className="input" value={`${d.desktopScheme}://`} disabled />
        </Field>
      </Panel>
      <button className="btn btn-primary" onClick={save}>Save brand</button>
      <Status error={error} ok={msg} />
    </>
  );
}

// ── Keys ────────────────────────────────────────────────────────────────────

function KeysTab() {
  const { data, error, reload, setError } = useResource('/api/admin/keys');
  const [edit, setEdit] = useState({});

  const save = async (key) => {
    setError(null);
    try {
      await api('/api/admin/keys', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, value: edit[key] }) });
      setEdit({ ...edit, [key]: undefined });
      reload();
    } catch (e) { setError(e.message); }
  };

  return (
    <Panel
      title="Runtime keys"
      hint="A value set here is stored in the database and shadows the environment variable of the same name, so a key can be changed without a redeploy. Secret values are never sent back to this page — only whether one is set and where it came from."
    >
      <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
        <tbody>
          {(data?.keys || []).map((k) => (
            <tr key={k.key} style={{ borderTop: '1px solid var(--line)' }}>
              <td className="mono" style={{ padding: '6px 8px 6px 0' }}>{k.key}</td>
              <td><span className="tag">{k.source}</span></td>
              <td style={{ width: '45%' }}>
                <input
                  className="input"
                  type={k.secret ? 'password' : 'text'}
                  placeholder={k.secret ? (k.set ? '•••••• (set)' : 'not set') : (k.value || 'not set')}
                  value={edit[k.key] ?? ''}
                  onChange={(e) => setEdit({ ...edit, [k.key]: e.target.value })}
                />
              </td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <button className="small" style={{ background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }} onClick={() => save(k.key)}>save</button>
                {k.source === 'db' && (
                  <button
                    className="small"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', marginLeft: 10 }}
                    onClick={async () => { await fetch(`/api/admin/keys?key=${k.key}`, { method: 'DELETE' }); reload(); }}
                  >
                    clear
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Status error={error} />
    </Panel>
  );
}

// ── Health ──────────────────────────────────────────────────────────────────

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
