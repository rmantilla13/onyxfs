'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Dialog from './Dialog';

/**
 * A one-field dialog, replacing the native prompt().
 *
 * usePrompt() returns a function that resolves to the entered string, or null
 * when dismissed, so a call site reads like the native one did:
 *
 *   const name = await prompt({ title: 'New folder', label: 'Name' });
 *   if (name == null) return;
 *
 * Two hooks keep the dialog open until the value is actually usable:
 *
 *   validate(value) → message | null   checked as you type, blocks submit
 *   submit(value)   → message | null   awaited on submit — the server's
 *                                      answer ("already exists") shows in the
 *                                      dialog instead of in a toast after it
 *                                      has closed on a name you must retype
 *
 * Enter submits; Escape and Cancel resolve null (Dialog handles focus
 * restoration to whatever opened it).
 */
export function usePrompt() {
  const [state, setState] = useState(null);

  const prompt = useCallback((opts = {}) => new Promise((resolve) => {
    setState({ ...opts, resolve });
  }), []);

  const settle = useCallback((value) => {
    setState((s) => { s?.resolve(value); return null; });
  }, []);

  const element = state ? <PromptDialog key={state.key || state.title} {...state} onDone={settle} /> : null;
  return { prompt, promptElement: element };
}

function PromptDialog({
  title, label, body, value: initial = '', placeholder, confirmLabel = 'Save',
  validate, submit, selectStem = false, onDone,
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const id = useId();

  // Select the name but not its extension, the way a file manager does, so
  // typing replaces "Q3 review" and keeps ".mov".
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    const dot = selectStem ? initial.lastIndexOf('.') : -1;
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial, selectStem]);

  const problem = validate ? validate(value) : null;

  const onSubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (problem) { setError(problem); return; }
    if (submit) {
      setBusy(true);
      let msg = null;
      try { msg = await submit(value.trim()); } catch (err) { msg = err?.message || 'Something went wrong.'; }
      setBusy(false);
      if (msg) { setError(msg); input.current?.focus(); return; }
    }
    onDone(value.trim());
  };

  const shown = error || (value !== initial && problem) || null;
  return (
    <Dialog
      open
      onClose={() => onDone(null)}
      title={title}
      dismissable={!busy}
      footer={(
        <>
          <button type="button" className="btn" onClick={() => onDone(null)} disabled={busy}>Cancel</button>
          <button type="submit" form={id} className="btn btn-primary" disabled={busy || !!problem}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      )}
    >
      <form id={id} onSubmit={onSubmit} className="stack" style={{ gap: 'var(--s2)' }}>
        {body && <p className="small muted" style={{ margin: 0 }}>{body}</p>}
        {label && <label className="small" htmlFor={`${id}-input`}>{label}</label>}
        <input
          id={`${id}-input`}
          ref={input}
          className="input"
          value={value}
          placeholder={placeholder}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          aria-invalid={!!shown}
          aria-describedby={shown ? `${id}-err` : undefined}
          autoComplete="off"
          spellCheck={false}
        />
        {shown && <p id={`${id}-err`} className="small" role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{shown}</p>}
      </form>
    </Dialog>
  );
}
