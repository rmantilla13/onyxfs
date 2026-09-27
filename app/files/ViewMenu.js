'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Menu, { MenuItem, MenuSeparator, MenuLabel } from '@/app/components/ui/Menu';
import Dialog from '@/app/components/ui/Dialog';
import Icon from '@/app/components/ui/Icon';
import { LIMITS } from '@/lib/views';

/**
 * Select view: the built-in views (lib/views.js), then the person's own —
 * the ones for everywhere and for the drive on screen — then saving the
 * view on screen as a new one, and managing the ones they have.
 *
 * Its button names the view on screen, or invites a choice while it is the
 * default; a saved view with unsaved changes carries a dot, and the menu
 * offers to save or revert them.
 */

/* icons: files clock image film audio-lines file-text file bookmark layers save undo-2 bookmark-plus square-pen */
export default function ViewMenu({
  view, builtins, mine, dirty, driveNames, onView, onSaveChanges, onRevert, onSaveAs, onManage, canManage,
}) {
  const label = view.id === 'all' && !dirty ? 'Select view' : view.name;
  return (
    <Menu
      ariaLabel={`View: ${view.name}${dirty ? ' (changed)' : ''}`}
      title={dirty ? `${view.name}: changed since it was saved` : undefined}
      buttonClassName={`btn btn-ghost tb-btn tb-view${label === 'Select view' ? ' is-default' : ''}`}
      menuClassName="view-menu"
      trigger={(
        <>
          <Icon name={view.id === 'all' ? 'layers' : view.icon || 'bookmark'} size={16} />
          <span className="tb-view-name truncate">{label}</span>
          {dirty && <span className="tb-dirty" aria-hidden />}
          <Icon name="chevron-down" size={14} className="tb-caret" />
        </>
      )}
    >
      <MenuLabel>Views</MenuLabel>
      {builtins.map((v) => (
        <MenuItem key={v.id} icon={v.icon} checked={view.id === v.id} onClick={() => onView(v.id)}>{v.name}</MenuItem>
      ))}
      <MenuSeparator />
      <MenuLabel>My views</MenuLabel>
      {mine.length ? mine.map((v) => (
        <MenuItem
          key={v.id}
          icon="bookmark"
          checked={view.id === v.id}
          hint={v.driveId ? driveNames.get(v.driveId) : undefined}
          onClick={() => onView(v.id)}
        >
          {v.name}
        </MenuItem>
      )) : <p className="menu-empty small muted">Views you save show here.</p>}
      <MenuSeparator />
      {dirty && <MenuItem icon="save" onClick={onSaveChanges}>Save changes to “{view.name}”</MenuItem>}
      {dirty && <MenuItem icon="undo-2" onClick={onRevert}>Revert changes</MenuItem>}
      <MenuItem icon="bookmark-plus" onClick={onSaveAs}>Save current view…</MenuItem>
      <MenuItem icon="square-pen" onClick={onManage} disabled={!canManage}>Manage views…</MenuItem>
    </Menu>
  );
}

/**
 * Name the view on screen and keep it. On a drive, it can be kept for that
 * drive alone; otherwise it is offered everywhere. `onSave(name, driveId)`
 * resolves to an error to show — a name already in use, say — or null.
 */
export function SaveViewDialog({ open, onClose, onSave, drive, suggestion = '' }) {
  const [name, setName] = useState('');
  const [scoped, setScoped] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const input = useRef(null);

  useEffect(() => {
    if (!open) return;
    setName(suggestion);
    setScoped(false);
    setError(null);
    setBusy(false);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
  }, [open, suggestion]);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const n = name.trim();
    if (!n) { setError('Give the view a name.'); return; }
    setBusy(true);
    const problem = await onSave(n, scoped && drive ? drive.id : null);
    setBusy(false);
    if (problem) { setError(problem); input.current?.focus(); }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Save current view"
      dismissable={!busy}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form={id} className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save view'}</button>
        </>
      )}
    >
      <form id={id} className="stack" onSubmit={submit}>
        <p className="small muted" style={{ margin: 0 }}>
          Keeps what is on screen — its filters, search, sort and display — under a name, in the Select view menu here and in the Mac app.
        </p>
        <label className="stack" style={{ gap: 'var(--s1)' }}>
          <span className="small">Name</span>
          <input
            ref={input}
            className="input"
            value={name}
            maxLength={LIMITS.name}
            placeholder="Selects for review"
            onChange={(e) => { setName(e.target.value); setError(null); }}
            aria-invalid={!!error}
          />
        </label>
        {drive && (
          <label className="admin-check">
            <input type="checkbox" checked={scoped} onChange={(e) => setScoped(e.target.checked)} />
            <span>
              <span className="small">Only in {drive.name}</span>
              <span className="small muted">Otherwise it is offered in every drive and in All files.</span>
            </span>
          </label>
        )}
        {error && <p className="small" role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p>}
      </form>
    </Dialog>
  );
}

/**
 * Every view the person has kept: rename one (on Enter or leaving the
 * field), change where it is offered, or delete it. Each change is saved as
 * it is made and says so if it could not be.
 */
export function ManageViewsDialog({ open, onClose, views, drives, onRename, onRescope, onDelete }) {
  const [errors, setErrors] = useState({});
  useEffect(() => { if (open) setErrors({}); }, [open]);
  const run = async (id, fn) => {
    const problem = await fn();
    setErrors((e) => ({ ...e, [id]: problem || null }));
  };
  return (
    <Dialog open={open} onClose={onClose} title="Manage views" wide footer={<button type="button" className="btn" onClick={onClose}>Done</button>}>
      {!views.length ? (
        <p className="small muted" style={{ margin: 0 }}>No saved views yet. Choose Save current view… in the Select view menu to keep one.</p>
      ) : (
        <ul className="views-manage">
          {views.map((v) => (
            <li key={v.id} className="views-manage-row">
              <Icon name="bookmark" size={16} className="muted" />
              <NameField value={v.name} label={`Name of ${v.name}`} onCommit={(name) => run(v.id, () => onRename(v, name))} />
              <select
                className="input views-manage-scope"
                aria-label={`Where ${v.name} is offered`}
                value={v.driveId || ''}
                onChange={(e) => run(v.id, () => onRescope(v, e.target.value || null))}
              >
                <option value="">Everywhere</option>
                {drives.map((d) => <option key={d.id} value={d.id}>Only in {d.name}</option>)}
              </select>
              <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`Delete ${v.name}`} title="Delete view" onClick={() => run(v.id, () => onDelete(v))}>
                <Icon name="trash" size={15} />
              </button>
              {errors[v.id] && <p className="small views-manage-error" role="alert">{errors[v.id]}</p>}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function NameField({ value, label, onCommit }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const commit = () => {
    const n = draft.trim();
    if (!n || n === value) { setDraft(value); return; }
    onCommit(n);
  };
  return (
    <input
      className="input views-manage-name"
      aria-label={label}
      value={draft}
      maxLength={LIMITS.name}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.stopPropagation(); setDraft(value); }
      }}
    />
  );
}
