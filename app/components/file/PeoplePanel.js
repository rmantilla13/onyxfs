'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Panel } from '@/app/components/ui/Layout';
import { useToast } from '@/app/components/ui/Toast';

/**
 * Per-file sharing.
 *
 * /api/files/[id]/acl is owner-or-admin only, so rendering this for anyone
 * else would be a control that 403s the moment it loads. `canManage` comes
 * from the server, which has already made that call; the wrapper renders
 * nothing rather than mounting a hidden editor, so no GET goes out either.
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
  { id: 'org', label: 'Anyone signed in', hint: 'Every account can open it, listed below or not.' },
  { id: 'custom', label: 'Specific people', hint: 'You, admins, and the people and roles listed below.' },
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Grants are matched against file_acl with a plain equality test: emails are
// stored lowercased by setFileAcl, role ids are not touched at all. Folding a
// role id's case here would quietly produce a grant that never matches.
const USERS = {
  normalize: (s) => s.trim().toLowerCase(),
  validate: (s) => (EMAIL.test(s) ? '' : `“${s}” is not an email address.`),
};
const ROLES = {
  normalize: (s) => s.trim(),
  validate: () => '',
};

const sameList = (a, b) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

/**
 * Fold whatever is in a chip input's text box into its value list. Split on
 * commas and whitespace so a pasted list becomes several chips at once.
 * Rejected entries stay behind as `leftover` so a typo can be corrected
 * instead of vanishing with the keystroke that submitted it.
 */
function foldDraft(text, values, { normalize, validate }) {
  const parts = String(text).split(/[,\s]+/).map(normalize).filter(Boolean);
  const next = [...values];
  const rejected = [];
  for (const p of parts) {
    if (validate(p)) rejected.push(p);
    else if (!next.includes(p)) next.push(p);
  }
  return {
    values: next,
    leftover: rejected.join(', '),
    error: rejected.length ? validate(rejected[0]) : '',
  };
}

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
  // What the server last confirmed, so Save and Discard can tell whether
  // there is anything to send.
  const [saved, setSaved] = useState({ visibility: 'owner', users: [], roles: [] });

  // The chip inputs' text boxes live up here so Save can fold them in. A
  // component-local draft would mean an address typed but not yet turned
  // into a chip is dropped by the one click meant to keep it.
  const [drafts, setDrafts] = useState({ users: '', roles: '' });
  const [errors, setErrors] = useState({ users: '', roles: '' });

  const knownRoles = useMemo(() => (
    Array.isArray(roles)
      ? roles.filter((r) => r && r.id).map((r) => ({ id: String(r.id), label: r.label || String(r.id) }))
      : []
  ), [roles]);

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
        setDrafts({ users: '', roles: '' });
        setErrors({ users: '', roles: '' });
      } catch (e) {
        if (e.name !== 'AbortError') setLoadError(e.message);
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [fileId, reloads]);

  const commit = useCallback((key, text) => {
    const spec = key === 'users' ? USERS : ROLES;
    const out = foldDraft(text, key === 'users' ? users : roleIds, spec);
    (key === 'users' ? setUsers : setRoleIds)(out.values);
    setDrafts((d) => ({ ...d, [key]: out.leftover }));
    setErrors((e) => ({ ...e, [key]: out.error }));
    return out;
  }, [users, roleIds]);

  const dirty = visibility !== saved.visibility
    || !sameList(users, saved.users)
    || !sameList(roleIds, saved.roles)
    // An uncommitted draft counts: otherwise Save sits disabled over an
    // address the person has already typed, with no way to press it.
    || Boolean(drafts.users.trim() || drafts.roles.trim());

  const save = useCallback(async () => {
    const u = foldDraft(drafts.users, users, USERS);
    const r = foldDraft(drafts.roles, roleIds, ROLES);
    setUsers(u.values);
    setRoleIds(r.values);
    setDrafts({ users: u.leftover, roles: r.leftover });
    setErrors({ users: u.error, roles: r.error });
    // Saving past a rejected entry would look like it went through. Stop and
    // let it be fixed — the rest of the edit is still on screen.
    if (u.error || r.error) return;

    setSaving(true);
    try {
      // PUT replaces the entire ACL, and a missing or non-array field coerces
      // to [] server-side and wipes that half of it. Always send both lists
      // in full, even when only visibility changed.
      const res = await fetch(`/api/files/${fileId}/acl`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility, users: u.values, roles: r.values }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `Could not save sharing (${res.status}).`);
      setSaved({ visibility, users: u.values, roles: r.values });
      toast.success('Sharing updated.');
      // Visibility lives on the file row the page was server-rendered from.
      router.refresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  }, [fileId, visibility, users, roleIds, drafts, toast, router]);

  const discard = () => {
    setVisibility(saved.visibility);
    setUsers(saved.users);
    setRoleIds(saved.roles);
    setDrafts({ users: '', roles: '' });
    setErrors({ users: '', roles: '' });
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

  const idle = visibility !== 'custom' && (users.length > 0 || roleIds.length > 0);

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

      {idle && (
        <p className="small acl-note">
          Only “Specific people” consults the list below. These grants are kept, but right now
          {visibility === 'org' ? ' anyone signed in can open this file.' : ' only you and admins can.'}
        </p>
      )}

      <ChipInput
        id={`${uid}-people`}
        label="People"
        hint="Type an email, then Enter or comma."
        placeholder="someone@example.com"
        values={users}
        draft={drafts.users}
        error={errors.users}
        onDraft={(t) => { setDrafts((d) => ({ ...d, users: t })); if (errors.users) setErrors((e) => ({ ...e, users: '' })); }}
        onCommit={(t) => commit('users', t)}
        onRemove={(v) => setUsers(users.filter((x) => x !== v))}
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
          id={`${uid}-roles`}
          label="Roles"
          // /api/admin/roles is admin-gated, so an owner who is not an admin
          // cannot be handed a list to pick from — they type the id instead.
          hint="Type a role id, then Enter or comma. Case-sensitive: admin, member, contributor, viewer, or a custom one."
          placeholder="contributor"
          values={roleIds}
          draft={drafts.roles}
          error={errors.roles}
          onDraft={(t) => setDrafts((d) => ({ ...d, roles: t }))}
          onCommit={(t) => commit('roles', t)}
          onRemove={(v) => setRoleIds(roleIds.filter((x) => x !== v))}
        />
      )}

      <p className="muted small" style={{ margin: '0 0 var(--s3)' }}>
        Everyone listed gets view access. There is no level to choose — the server records every
        grant as a viewer.
      </p>

      <div className="row">
        <button className="btn btn-primary btn-sm" onClick={save} disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save sharing'}
        </button>
        {dirty && !saving && <button className="btn btn-ghost btn-sm" onClick={discard}>Discard</button>}
      </div>
    </Panel>
  );
}

/** Select-and-add, used only when the caller was able to enumerate the roles. */
function RolePicker({ id, options, values, onChange }) {
  const [pick, setPick] = useState('');
  const free = options.filter((o) => !values.includes(o.id));
  const labelOf = (v) => options.find((o) => o.id === v)?.label || v;

  return (
    <div style={{ marginBottom: 'var(--s3)' }}>
      <label className="small acl-label" htmlFor={id}>Roles</label>
      <Chips values={values} labelOf={labelOf} onRemove={(v) => onChange(values.filter((x) => x !== v))} />
      <div className="row acl-role-add">
        <select
          id={id}
          className="input"
          value={pick}
          disabled={free.length === 0}
          onChange={(e) => setPick(e.target.value)}
        >
          <option value="">{free.length ? 'Add a role…' : 'Every role is already listed'}</option>
          {free.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <button className="btn btn-sm" disabled={!pick} onClick={() => { onChange([...values, pick]); setPick(''); }}>
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

/** Add-chip entry. Fully controlled: the draft and its error belong to the parent. */
function ChipInput({ id, label, hint, placeholder, values, draft, error, onDraft, onCommit, onRemove }) {
  const errorId = `${id}-error`;
  return (
    <div style={{ marginBottom: 'var(--s3)' }}>
      <label className="small acl-label" htmlFor={id}>{label}</label>
      <Chips values={values} onRemove={onRemove} />
      <input
        id={id}
        className="input"
        type="text"
        value={draft}
        placeholder={placeholder}
        autoComplete="off"
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? 'true' : undefined}
        onChange={(e) => {
          const v = e.target.value;
          // Typing or pasting a comma is the same gesture as pressing Enter.
          if (v.includes(',')) onCommit(v); else onDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onCommit(draft); }
          else if (e.key === 'Backspace' && !draft && values.length) onRemove(values[values.length - 1]);
        }}
        onBlur={() => { if (draft.trim()) onCommit(draft); }}
      />
      {error
        ? <div id={errorId} className="small acl-error" role="alert">{error}</div>
        : hint && <div className="muted small" style={{ marginTop: 'var(--s1)' }}>{hint}</div>}
    </div>
  );
}
