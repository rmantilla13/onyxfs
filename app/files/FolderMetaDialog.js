'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Dialog from '@/app/components/ui/Dialog';

/**
 * A folder's own tags and metadata (PUT /api/files/folders/meta). The files
 * inside it inherit them as far as collections are concerned: tag a folder
 * "spring" and a collection asking for that tag lists everything in it.
 *
 * `meta` is what the folder carries now ({ tags?, metadata? }, from the
 * folder tree). `onSave({ tags, metadata })` resolves an error message, or
 * null when it saved. A field left empty is cleared.
 */
export default function FolderMetaDialog({ open, folder, meta, schema, onClose, onSave }) {
  const [tags, setTags] = useState('');
  const [values, setValues] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const tagsRef = useRef(null);
  const fields = schema?.fields || [];

  useEffect(() => {
    if (!open) return;
    setTags((meta?.tags || []).join(', '));
    const md = meta?.metadata || {};
    setValues(Object.fromEntries(fields.map((f) => [f.key, Array.isArray(md[f.key]) ? md[f.key].join(', ') : md[f.key] ?? ''])));
    setError(null);
    setBusy(false);
    tagsRef.current?.focus();
  }, [open, meta]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const metadata = {};
    for (const f of fields) {
      const v = String(values[f.key] ?? '').trim();
      if (f.type === 'multiselect') {
        const list = v.split(',').map((s) => s.trim()).filter(Boolean);
        metadata[f.key] = list.length ? list : null;
      } else {
        metadata[f.key] = v || null;
      }
    }
    setBusy(true);
    const problem = await onSave({ tags: tags.split(',').map((s) => s.trim()).filter(Boolean), metadata });
    setBusy(false);
    if (problem) setError(problem);
  };

  const name = folder ? folder.slice(folder.lastIndexOf('/') + 1) : '';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Tags and metadata of “${name}”`}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form={id} className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </>
      )}
    >
      <form id={id} className="stack" onSubmit={submit}>
        <p className="small muted" style={{ margin: 0 }}>
          Every file in this folder, and in the folders inside it, counts as having these in collections.
          The files themselves are not changed.
        </p>
        <label className="stack" style={{ gap: 'var(--s1)' }}>
          <span className="small">Tags <span className="muted">(comma-separated)</span></span>
          <input ref={tagsRef} className="input" value={tags} placeholder="spring, launch" onChange={(e) => { setTags(e.target.value); setError(null); }} />
        </label>
        {fields.map((f) => {
          const set = (v) => { setValues((vs) => ({ ...vs, [f.key]: v })); setError(null); };
          return (
            <label key={f.key} className="stack" style={{ gap: 'var(--s1)' }}>
              <span className="small">{f.label}{f.type === 'multiselect' && <span className="muted"> (comma-separated)</span>}</span>
              {f.type === 'select' && f.options?.length ? (
                <select className="input" value={values[f.key] || ''} onChange={(e) => set(e.target.value)}>
                  <option value="">—</option>
                  {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input className="input" type={f.type === 'date' ? 'date' : 'text'} value={values[f.key] || ''}
                  list={f.options?.length ? `${id}-${f.key}` : undefined} onChange={(e) => set(e.target.value)} />
              )}
              {f.type !== 'select' && f.options?.length > 0 && (
                <datalist id={`${id}-${f.key}`}>{f.options.map((o) => <option key={o} value={o} />)}</datalist>
              )}
            </label>
          );
        })}
        {error && <p className="small" role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p>}
      </form>
    </Dialog>
  );
}
