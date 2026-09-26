'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Dialog from '@/app/components/ui/Dialog';

/**
 * A confirm for something that cannot be taken back: revoking someone's
 * access, repointing the library's storage.
 *
 * Unlike ui/Confirm, a stray click on the backdrop does not answer it, and
 * the focus starts on Cancel, so Enter on a dialog that appeared under the
 * cursor keeps things as they are. Escape still cancels — the safe answer
 * is always one key away.
 *
 * NOTE: ui/Confirm.js is gaining a `destructive` prop on another branch
 * (Phase 0) that does exactly this. When it lands, replace this hook with
 * useConfirm() + `destructive: true` and delete this file.
 *
 *   const { confirm, confirmElement } = useDestructiveConfirm();
 *   if (!(await confirm({ title, body, confirmLabel }))) return;
 */
export function useDestructiveConfirm() {
  const [state, setState] = useState(null);
  const cancelRef = useRef(null);

  const confirm = useCallback((opts = {}) => new Promise((resolve) => {
    setState({ ...opts, resolve });
  }), []);

  const settle = useCallback((answer) => {
    setState((s) => { s?.resolve(answer); return null; });
  }, []);

  // The dialog is not dismissable, which also swallows Escape (its cancel
  // event is prevented); give Escape back as Cancel.
  const open = !!state;
  useEffect(() => {
    if (!open) return undefined;
    // After Dialog's showModal (a child's effect runs first): React's
    // autoFocus fires while the dialog is still closed, so it is done here.
    cancelRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') settle(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, settle]);

  const element = state ? (
    <Dialog
      open
      dismissable={false}
      onClose={() => settle(false)}
      title={state.title || 'Are you sure?'}
      footer={(
        <>
          <button type="button" className="btn" ref={cancelRef} onClick={() => settle(false)}>{state.cancelLabel || 'Cancel'}</button>
          <button type="button" className="btn btn-danger" onClick={() => settle(true)}>{state.confirmLabel || 'Delete'}</button>
        </>
      )}
    >
      {typeof state.body === 'string'
        ? <p className="small muted admin-note">{state.body}</p>
        : state.body}
    </Dialog>
  ) : null;

  return { confirm, confirmElement: element };
}
