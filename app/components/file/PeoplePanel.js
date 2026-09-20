'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Panel } from '@/app/components/ui/Layout';
import { useToast } from '@/app/components/ui/Toast';

/**
 * Per-file sharing.
 *
 * /api/files/[id]/acl is owner-or-admin only, so rendering this for anyone
 * else would just be a control that 403s on load. `canManage` comes from the
 * server, which has already made that call; the wrapper renders nothing
 * rather than hiding a mounted editor, so no GET goes out either.
 */
export default function PeoplePanel({ fileId, canManage, roles }) {
  if (!canManage) return null;
  return <AclEditor fileId={fileId} roles={roles} />;
}

/**
 * The three literals the server accepts. setFileVisibility falls back to
 * 'owner' for anything else, silently — so this list is the whole vocabulary
 * and nothing here may invent a fourth value.
 */
const VISIBILITIES = [
  { id: 'owner', label: 'Only you', hint: 'You and admins. Nobody else can open it.' },
  { id: 'org', label: 'Anyone signed in', hint: 'Everyone with an account can open it, listed below or not.' },
  { id: 'custom', label: 'Specific people', hint: 'You, admins, and the people and roles listed below.' },
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sameList = (a, b) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

function AclEditor({ fileId, roles }) {
  const toast = useToast();
  const router = useRouter();
  const uid = useId();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [reloads, setReloads] = useState(0);

  const [visibility, setVisibility] = useState('owner');
  const [users, setUsers] = useState([]);
  const [roleIds, setRoleIds] = useState([]);
  // What the server last confirmed, so Save/Reset can tell whether there is
  // anything to send.
  const [saved, setSaved] = useState({ visibility: 'owner', users: [], roles: [] });

  const knownRoles = useMemo(
    () => (Array.isArray(roles) ? roles.filter((r) => r && r.id).map((r) => ({ id: String(r.id), label: r.label || String(r.id) })) : []),
    [roles],
  );

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setLoadError('');
    (async () => {
      try {
        const r = await fetch(`/api/files/${fileId}/acl`, { signal: ac.signal });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.error || `Could not load sharing (${r.status}).`);
        const acl = Array.isArray(out.acl) ? out.acl : [];
        const next = {
          visibility: VISIBILITIES.some((v) => v.id === out.visibility) ? out.visibility : 'owner',
          users: [...new Set(acl.filter((g) => g.scope === 'user').map((g) => String(g.principal)))],
          roles: [...new Set(acl.filter((g) => g.scope === 'role').map((g) => String(g.principal)))],
        };
        setVisibility(next.visibility);
        setUsers(next.users);
        setRoleIds(next.roles);
        setSaved(next);
      } catch (e) {
        if (e.name !== 'AbortError') setLoadError(e.message);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [fileId, reloads]);

  // Drafts live in the chip inputs. Save reads them through these refs so a
  // typed-but-not-yet-committed address is not silently dropped by the one
  // click the person expects to keep it.
  const userDraft = useRef(null);
  const roleDraft = useRef(null);

  const dirty = visibility !== saved.visibility || !sameList(users, saved.users) || !sameList(roleIds, saved.roles);

  const save = useCallback(async () => {
    const nextUsers = userDraft.current?.flush() ?? users;
    const nextRoles = roleDraft.current?.flush() ?? roleIds;
    setSaving(true);
    try {
      // PUT replaces the whole ACL — a missing or non-array field coerces to
      // [] server-side and wipes that half. Always send both lists in full.
      const r = await fetch(`/api/files/${fileId}/acl`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility, users: nextUsers, roles: nextRoles }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || `Could not save sharing (${r.status}).`);
      setSaved({ visibility, users: nextUsers, roles: nextRoles });
      toast.success('Sharing updated.');
      // Visibility lives on the file row the page was server-rendered from.
      router.refresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }, [fileId, visibility, users, roleIds, toast, router]);

  const reset = () => {
    setVisibility(saved.visibility);
    setUsers(saved.users);
    setRoleIds(saved.roles);
    userDraft.current?.clear();
    roleDraft.current?.clear();
  };

  if (loading) {
    return <Panel title="People"><p className="muted small" style={{ margin: 0 }}>Loading sharing…</p></Panel>;
  }

  if (loadError) {
    return (
      <Panel title="People">
        <p className="small" style={{ margin: '0 0 var(--s3)' }}>{loadError}</p>
        <button className="btn btn-sm" onClick={() => setReloads((n) => n + 1)}>Try again</button>
      </Panel>
    );
  }

  const grantsIdle = visibility !== 'custom';

  return (
    <Panel title="People" hint="Who can open this file.">
      <div className="acl-vis" role="radiogroup" aria-label="Visibility">
        {VISIBILITIES.map((v) => (
          <label key={v.id} htmlFor={`${uid}-${v.id}`}>
            <input
              id={`${uid}-${v.id}`}
              type="radio"
              name={`${uid}-visibility`}
              value={v.id}
              checked={visibility === v.id}
              onChange={() => setVisibility(v.id)}
            />
            <span>{v.label}</span>
            <span className="muted small acl-vis-hint">{v.hint}</span>
          </label>
        ))}
      </div>

      {grantsIdle && (users.length > 0 || roleIds.length > 0) && (
        <p className="muted small acl-note">
          These grants are saved but not in effect — only “Specific people” consults them.
          {visibility === 'org' ? ' Right now anyone signed in can open this file.' : ' Right now only you and admins can.'}
        </p>
      )}

      <ChipInput
        ref={userDraft}
        id={`${uid}-people`}
        label="People"
        hint="Type an email, then Enter or comma."
        placeholder="someone@example.com"
        values={users}
        onChange={setUsers}
        normalize={(s) => s.trim().toLowerCase()}
        validate={(s) => (EMAIL.test(s) ? '' : `“${s}” is not an email address.`)}
      />

      {knownRoles.length > 0 ? (
        <RolePicker
          id={`${uid}-roles`}
          options={knownRoles}
          values={roleIds}
          onChange={setRoleIds}
        />
      ) : (
        <ChipInput
          ref={roleDraft}
          id={`${uid}-roles`}
          label="Roles"
          // /api/admin/roles is admin-gated, so an owner who is not an admin
          // cannot be handed a list to choose from — they type the id. It is
          // matched case-sensitively against file_acl, so it is not folded.
          hint="Type a role id, then Enter or comma. Case-sensitive: admin, member, contributor, viewer, or a custom one."
          placeholder="contributor"
          values={roleIds}
          onChange={setRoleIds}
          normalize={(s) => s.trim()}
          validate={() => ''}
        />
      )}

      <p className="muted small" style={{ margin: '0 0 var(--s3)' }}>
        Everyone listed gets view access. This panel cannot grant more than that — the server stores
        every grant as a viewer.
      </p>

      <div className="row">
        <button className="btn btn-primary btn-sm" onClick={save} disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save sharing'}
        </button>
        {dirty && !saving && (
          <button className="btn btn-ghost btn-sm" onClick={reset}>Discard</button>
        )}
      </div>
    </Panel>
  );
}

/** A select-and-add list, used when the caller could enumerate the roles. */
function RolePicker({ id, options, values, onChange }) {
  const [pick, setPick] = useState('');
  const free = options.filter((o) => !values.includes(o.id));
  const labelOf = (v) => options.find((o) => o.id === v)?.label || v;

  return (
    <div style={{ marginBottom: 'var(--s3)' }}>
      <div className="small" style={{ marginBottom: 'var(--s1)', fontWeight: 500 }}>Roles</div>
      <Chips values={values} labelOf={labelOf} onRemove={(v) => onChange(values.filter((x) => x !== v))} />
      <div className="row" style={{ gap: 'var(--s2)' }}>
        <select
          id={id}
          className="input"
          value={pick}
          disabled={free.length === 0}
          onChange={(e) => setPick(e.target.value)}
          aria-label="Add a role"
        >
          <option value="">{free.length ? 'Add a role…' : 'Every role is already listed'}</option>
          {free.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <button
          className="btn btn-sm"
          disabled={!pick}
          onClick={() => { onChange([...values, pick]); setPick(''); }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function Chips({ values, labelOf = (v) => v, onRemove }) {
  if (!values.length) return null;
  return (
    <ul className="acl-chips">
      {values.map((v) => (
        <li key={v} className="acl-chip">
          <span title={v}>{labelOf(v)}</span>
          <button className="acl-chip-x" onClick={() => onRemove(v)} aria-label={`Remove ${v}`}>
            <span aria-hidden>✕</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Add-chip entry. The parent holds a ref to it so Save can `flush()` whatever
 * is still sitting in the text box and get the resulting list back
 * synchronously — waiting for the setState to land would send the stale one.
 */
function ChipInput({ ref, id, label, hint, placeholder, values, onChange, normalize, validate }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  // Kept in sync so flush() reads current values without the parent having to
  // pass them through a second channel.
  const latest = useRef(values);
  latest.current = values;

  /** Split on commas and whitespace so a pasted list becomes several chips. */
  const commit = (text) => {
    const parts = String(text).split(/[,\s]+/).map(normalize).filter(Boolean);
    if (!parts.length) return latest.current;
    const next = [...latest.current];
    let bad = '';
    for (const p of parts) {
      const why = validate(p);
      if (why) { bad = bad || why; continue; }
      if (!next.includes(p)) next.push(p);
    }
    setError(bad);
    // A rejected entry stays in the box so it can be corrected rather than
    // disappearing along with the typo.
    setDraft(bad ? parts.find((p) => validate(p)) || '' : '');
    latest.current = next;
    onChange(next);
    return next;
  };

  if (ref) {
    ref.current = {
      flush: () => commit(draft),
      clear: () => { setDraft(''); setError(''); },
    };
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Backspace' && !draft && values.length) {
      onChange(values.slice(0, -1));
    }
  };

  const errorId = `${id}-error`;

  return (
    <div style={{ marginBottom: 'var(--s3)' }}>
      <label className="small" htmlFor={id} style={{ display: 'block', marginBottom: 'var(--s1)', fontWeight: 500 }}>{label}</label>
      <Chips values={values} onRemove={(v) => { const next = values.filter((x) => x !== v); latest.current = next; onChange(next); }} />
      <input
        id={id}
        className="input"
        type="text"
        value={draft}
        placeholder={placeholder}
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? 'true' : undefined}
        onChange={(e) => {
          const v = e.target.value;
          // Typing or pasting a comma is the same gesture as pressing Enter.
          if (v.includes(',')) commit(v);
          else { setDraft(v); if (error) setError(''); }
        }}
        onKeyDown={onKeyDown}
        onBlur={() => { if (draft.trim()) commit(draft); }}
      />
      {error
        ? <div id={errorId} className="small" role="alert" style={{ marginTop: 'var(--s1)', color: 'var(--danger)' }}>{error}</div>
        : hint && <div className="muted small" style={{ marginTop: 'var(--s1)' }}>{hint}</div>}
    </div>
  );
}
