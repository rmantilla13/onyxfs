'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { useConfirm } from './ui/Confirm';

const ROLES = [
  { key: 'viewer', label: 'Viewer', hint: 'Read-only desktop mount.' },
  { key: 'editor', label: 'Editor', hint: 'Read-write desktop mount.' },
  { key: 'owner', label: 'Owner', hint: 'Read-write, and can manage these members.' },
];

async function api(url, opts) {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`);
  return body;
}

/**
 * Members of one filespace: list, change role, remove, add. Used by the Admin
 * panel and by the files UI's "Members" dialog, against the same route
 * (/api/filespaces/[id]/members), which admits admins and the filespace's
 * owners and enforces the rules — this component only mirrors them so it does
 * not offer a control the server will refuse.
 */
export default function FilespaceMembers({ filespaceId, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [draft, setDraft] = useState({ email: '', role: 'viewer' });
  const { confirm, confirmElement } = useConfirm();
  const listId = useId();
  const url = `/api/filespaces/${encodeURIComponent(filespaceId)}/members`;

  const load = useCallback(() => {
    api(url).then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message));
  }, [url]);
  useEffect(load, [load]);

  const change = async (email, body, label) => {
    setBusy(label); setError(null);
    try {
      await api(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, ...body }) });
      load();
      onChanged?.();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const add = async (e) => {
    e.preventDefault();
    const email = draft.email.trim().toLowerCase();
    if (!email) return;
    if (await change(email, { role: draft.role }, 'add')) setDraft({ email: '', role: draft.role });
  };

  const remove = async (m) => {
    const ok = await confirm({
      title: `Remove ${m.email}?`,
      body: 'They lose this filespace in the switcher and the desktop app. A desktop mount they already have keeps working until its credentials next refresh (within an hour). Files are not affected.',
      confirmLabel: 'Remove',
    });
    if (ok) change(m.email, { grant: false }, `rm:${m.email}`);
  };

  if (!data) return error ? <p className="small" style={{ color: 'var(--danger)', margin: 0 }}>{error}</p> : <p className="small muted" style={{ margin: 0 }}>Loading members…</p>;

  const self = data.self || {};
  const members = data.members || [];

  return (
    <div className="fs-members">
      {members.length === 0 ? (
        <p className="small muted" style={{ margin: '0 0 12px' }}>No members yet. Admins reach every filespace without being listed.</p>
      ) : (
        <table className="fs-members-table">
          <tbody>
            {members.map((m) => {
              const isSelf = m.email === self.email;
              // Owners cannot change their own grant; the server says so too.
              const locked = !self.isAdmin && isSelf;
              return (
                <tr key={m.email}>
                  <td className="fs-members-email">
                    <span title={m.email}>{m.email}</span>
                    {isSelf && <span className="tag" style={{ marginLeft: 6 }}>you</span>}
                  </td>
                  <td style={{ width: 1 }}>
                    <select
                      className="input"
                      aria-label={`Role for ${m.email}`}
                      value={m.role}
                      disabled={locked || !!busy}
                      title={locked ? 'Ask another owner or an admin to change your access.' : undefined}
                      onChange={(e) => change(m.email, { role: e.target.value }, `role:${m.email}`)}
                    >
                      {ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                    </select>
                  </td>
                  <td style={{ width: 1, textAlign: 'right' }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={locked || !!busy}
                      onClick={() => remove(m)}
                    >
                      {busy === `rm:${m.email}` ? 'Removing…' : 'Remove'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <form className="fs-members-add" onSubmit={add}>
        <input
          className="input"
          type="email"
          aria-label="Email to add"
          placeholder="someone@example.com"
          list={listId}
          value={draft.email}
          onChange={(e) => setDraft({ ...draft, email: e.target.value })}
        />
        <datalist id={listId}>
          {(data.users || []).map((u) => <option key={u.email} value={u.email}>{u.name || ''}</option>)}
        </datalist>
        <select
          className="input"
          aria-label="Role to grant"
          value={draft.role}
          onChange={(e) => setDraft({ ...draft, role: e.target.value })}
        >
          {ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <button className="btn" type="submit" disabled={!draft.email.trim() || !!busy}>
          {busy === 'add' ? 'Adding…' : 'Add'}
        </button>
      </form>
      <p className="small muted" style={{ margin: '8px 0 0' }}>
        {ROLES.map((r) => `${r.label}: ${r.hint}`).join(' ')}
      </p>
      {error && <p className="small" role="alert" style={{ color: 'var(--danger)', margin: '8px 0 0' }}>{error}</p>}
      {confirmElement}
    </div>
  );
}
