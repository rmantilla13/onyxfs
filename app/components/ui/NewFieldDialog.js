'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Dialog from './Dialog';
import { METADATA_FIELD_TYPES } from '@/lib/dam';

/**
 * Add a field to the workspace's metadata schema — from the Display
 * popover's metadata fields, for admins. `onCreate` resolves to an error
 * message to show, or null once the field exists — the dialog stays open on
 * a clash so the name can be changed rather than retyped.
 */
export default function NewFieldDialog({ open, onClose, onCreate }) {
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
