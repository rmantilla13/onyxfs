'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Popover from './Popover';
import Dialog from './Dialog';
import { moveColumn } from '@/lib/list-columns';
import { METADATA_FIELD_TYPES } from '@/lib/dam';

/**
 * Which columns the list shows, and in what order. Opened from the end of the
 * list's header row.
 *
 * Shown columns come first, in their order, each with a pair of buttons to
 * move it; everything else follows by group. Name is always shown and always
 * first, so it is listed but cannot be unticked. Admins also get a way to add
 * a metadata field, which lands here as a new column, already ticked.
 */
export default function ColumnPicker({ available, visible, onChange, onReset, onAddField, waiting = [] }) {
  const byKey = new Map(available.map((c) => [c.key, c]));
  const shown = visible.map((k) => byKey.get(k)).filter(Boolean);
  const hidden = available.filter((c) => !visible.includes(c.key));
  const groups = [...new Set(hidden.map((c) => c.group))];
  // Chosen, but past what fits at this width (fitColumns in lib/list-columns.js).
  const late = new Set(waiting);

  return (
    <Popover
      label={late.size ? `Choose columns (${late.size} waiting for room)` : 'Choose columns'}
      buttonClassName="btn btn-ghost btn-sm filelist-colbtn"
      className="colpick"
      trigger={(
        <>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <path d="M2.5 3h11v10h-11zM6.3 3v10M9.8 3v10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
          {late.size > 0 && <span className="colpick-count" aria-hidden>+{late.size}</span>}
        </>
      )}
    >
      {({ close }) => (
        <>
          <div className="colpick-head">
            <strong className="small">Columns</strong>
            <div className="spacer" />
            <button type="button" className="btn btn-ghost btn-sm" onClick={onReset}>Reset</button>
          </div>

          <p className="colpick-label">Shown</p>
          {late.size > 0 && (
            <p className="small muted colpick-note">
              {late.size === 1 ? 'One column does' : `${late.size} columns do`} not fit at this width. Move {late.size === 1 ? 'it' : 'them'} earlier, or hide another.
            </p>
          )}
          <label className="colpick-row is-locked">
            <input type="checkbox" checked disabled />
            <span className="truncate">Name</span>
          </label>
          {shown.map((c, i) => (
            <div className="colpick-row" key={c.key}>
              <label className="colpick-check">
                <input type="checkbox" checked onChange={() => onChange(visible.filter((k) => k !== c.key))} />
                <span className="truncate">{c.label}</span>
                {late.has(c.key) && <span className="colpick-hint" title="Widen the window, or move it earlier">no room</span>}
              </label>
              <button
                type="button"
                className="btn btn-ghost btn-sm colpick-move"
                aria-label={`Move ${c.label} earlier`}
                title="Move earlier"
                disabled={i === 0}
                onClick={() => onChange(moveColumn(visible, c.key, -1))}
              >
                ↑
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm colpick-move"
                aria-label={`Move ${c.label} later`}
                title="Move later"
                disabled={i === shown.length - 1}
                onClick={() => onChange(moveColumn(visible, c.key, 1))}
              >
                ↓
              </button>
            </div>
          ))}

          {groups.map((g) => (
            <div key={g}>
              <p className="colpick-label">{g}</p>
              {hidden.filter((c) => c.group === g).map((c) => (
                <label className="colpick-row" key={c.key}>
                  <input type="checkbox" checked={false} onChange={() => onChange([...visible, c.key])} />
                  <span className="truncate">{c.label}</span>
                  {c.edit && <span className="colpick-hint">editable</span>}
                </label>
              ))}
            </div>
          ))}

          {onAddField && (
            <div className="colpick-foot">
              <button type="button" className="btn btn-sm" onClick={() => { close(); onAddField(); }}>
                New metadata field…
              </button>
            </div>
          )}
        </>
      )}
    </Popover>
  );
}

/**
 * Add a field to the workspace's metadata schema. `onCreate` resolves to an
 * error message to show, or null once the field exists — the dialog stays
 * open on a clash so the name can be changed rather than retyped.
 */
export function NewFieldDialog({ open, onClose, onCreate }) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState('text');
  const [options, setOptions] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const nameRef = useRef(null);
  const listed = type === 'select' || type === 'multiselect';

  // After showModal() (Dialog's effect runs before this one), which would
  // otherwise leave focus on the close button.
  useEffect(() => { if (open) nameRef.current?.focus(); }, [open]);

  const reset = () => { setLabel(''); setType('text'); setOptions(''); setError(null); setBusy(false); };
  const dismiss = () => { reset(); onClose(); };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!label.trim()) { setError('Give the field a name.'); return; }
    setBusy(true);
    const problem = await onCreate({ label: label.trim(), type, options: listed ? options : undefined });
    setBusy(false);
    if (problem) { setError(problem); return; }
    reset();
  };

  return (
    <Dialog
      open={open}
      onClose={dismiss}
      title="New metadata field"
      footer={(
        <>
          <button type="button" className="btn" onClick={dismiss}>Cancel</button>
          <button type="submit" form={id} className="btn btn-primary" disabled={busy}>
            {busy ? 'Adding…' : 'Add field'}
          </button>
        </>
      )}
    >
      <form id={id} className="stack" onSubmit={submit}>
        <p className="small muted" style={{ margin: 0 }}>
          Every file gets this field. It becomes a list column you can edit in place, and a filter.
        </p>
        <label className="stack" style={{ gap: 'var(--s1)' }}>
          <span className="small">Name</span>
          <input ref={nameRef} className="input" value={label} onChange={(e) => { setLabel(e.target.value); setError(null); }} placeholder="Client" maxLength={60} />
        </label>
        <label className="stack" style={{ gap: 'var(--s1)' }}>
          <span className="small">Type</span>
          <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
            {METADATA_FIELD_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
          </select>
        </label>
        {listed && (
          <label className="stack" style={{ gap: 'var(--s1)' }}>
            <span className="small">Choices <span className="muted">(comma-separated, optional)</span></span>
            <input className="input" value={options} onChange={(e) => setOptions(e.target.value)} placeholder="Acme, Globex, Initech" />
          </label>
        )}
        {error && <p className="small" role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p>}
      </form>
    </Dialog>
  );
}
