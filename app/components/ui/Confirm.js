'use client';

import { useCallback, useState } from 'react';
import Dialog from './Dialog';

/**
 * Destructive-action confirmation, replacing the native confirm() calls.
 *
 * Native confirm() is synchronous, unstyleable, blocks the whole tab, and on
 * a phone renders as a browser sheet that says the origin's hostname above
 * your sentence. It is also unusable from a server action or anything async.
 *
 * useConfirm() returns a function that resolves to a boolean, so the call
 * site reads the same way the native one did:
 *
 *   if (!(await confirm({ title: 'Delete 3 files?' }))) return;
 */
export function useConfirm() {
  const [state, setState] = useState(null);

  const confirm = useCallback((opts = {}) => new Promise((resolve) => {
    setState({ ...opts, resolve });
  }), []);

  const settle = useCallback((answer) => {
    setState((s) => { s?.resolve(answer); return null; });
  }, []);

  const element = state ? (
    <Dialog
      open
      onClose={() => settle(false)}
      title={state.title || 'Are you sure?'}
      footer={(
        <>
          <button className="btn" onClick={() => settle(false)}>{state.cancelLabel || 'Cancel'}</button>
          <button
            className={`btn ${state.danger === false ? 'btn-primary' : 'btn-danger'}`}
            onClick={() => settle(true)}
            autoFocus
          >
            {state.confirmLabel || 'Delete'}
          </button>
        </>
      )}
    >
      {state.body && <p className="small muted" style={{ margin: 0 }}>{state.body}</p>}
    </Dialog>
  ) : null;

  return { confirm, confirmElement: element };
}
