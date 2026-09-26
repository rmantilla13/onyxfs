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
 *
 * `destructive: true` is for the ones that cannot be undone — removing a
 * person, purging the trash. Two things change, both so that the reflexive
 * gesture is the safe one: a click on the backdrop or Escape no longer
 * closes it, so it cannot be waved away half-read, and Cancel rather than
 * the red button has the focus, so Enter keeps things as they are.
 */
export function useConfirm() {
  const [state, setState] = useState(null);

  const confirm = useCallback((opts = {}) => new Promise((resolve) => {
    setState({ ...opts, resolve });
  }), []);

  const settle = useCallback((answer) => {
    setState((s) => { s?.resolve(answer); return null; });
  }, []);

  const destructive = !!state?.destructive;
  const element = state ? (
    <Dialog
      open
      onClose={() => settle(false)}
      title={state.title || 'Are you sure?'}
      dismissable={!destructive}
      footer={(
        <>
          <button className="btn" onClick={() => settle(false)} autoFocus={destructive}>
            {state.cancelLabel || 'Cancel'}
          </button>
          <button
            className={`btn ${state.danger === false && !destructive ? 'btn-primary' : 'btn-danger'}`}
            onClick={() => settle(true)}
            autoFocus={!destructive}
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
