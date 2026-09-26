'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Dialog from '@/app/components/ui/Dialog';
import { deleteDriveConsequence } from '@/lib/admin-drives';

/**
 * Deleting a drive, from the files page's drive menu and from Admin →
 * Drives: one confirm, so both say the same thing.
 *
 * It asks the server what the drive holds (GET /api/admin/filespaces
 * ?summary=<id>) before offering the button, because the consequence is
 * the point of the question: the files stay, and without the drive around
 * them they become visible to everyone who can see All files.
 *
 * Destructive, so a click on the backdrop does not answer it and the focus
 * starts on Cancel. (ui/Confirm gains a `destructive` prop on another
 * branch; this dialog has its own loading and error states, so it stays a
 * dialog of its own either way.)
 *
 *   const { deleteDrive, deleteElement } = useDeleteDrive();
 *   const done = await deleteDrive(drive);   // { id, filesKept } or null
 */
export function useDeleteDrive() {
  const [state, setState] = useState(null);

  const deleteDrive = useCallback((drive) => new Promise((resolve) => {
    setState({ drive, resolve });
  }), []);

  const finish = useCallback((result) => {
    setState((s) => { s?.resolve(result); return null; });
  }, []);

  const element = state ? <DeleteDriveDialog drive={state.drive} onDone={finish} /> : null;
  return { deleteDrive, deleteElement: element };
}

function DeleteDriveDialog({ drive, onDone }) {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const cancelRef = useRef(null);

  useEffect(() => {
    let live = true;
    setSummary(null); setError(null);
    fetch(`/api/admin/filespaces?summary=${encodeURIComponent(drive.id)}`, { cache: 'no-store' })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!live) return;
        if (!r.ok) setError(body.error || `Could not check what the drive holds (HTTP ${r.status}).`);
        else setSummary(body);
      })
      .catch(() => { if (live) setError('Could not reach the server. Check the connection and try again.'); });
    return () => { live = false; };
  }, [drive.id, attempt]);

  // After the dialog has opened (Dialog's effect runs first), so the focus
  // lands on the safe answer.
  useEffect(() => { cancelRef.current?.focus(); }, []);

  // Not dismissable, which also swallows Escape; give Escape back as Cancel.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onDone(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onDone]);

  const confirm = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/admin/filespaces?id=${encodeURIComponent(drive.id)}`, { method: 'DELETE' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { setError(body.error || `Could not delete the drive (HTTP ${r.status}).`); return; }
      onDone({ id: drive.id, name: drive.name, filesKept: Number(body.filesKept) || 0 });
    } catch {
      setError('Could not reach the server. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      dismissable={false}
      onClose={() => onDone(null)}
      title={`Delete the drive “${drive.name}”?`}
      footer={(
        <>
          <button type="button" className="btn" ref={cancelRef} onClick={() => onDone(null)} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-danger" onClick={confirm} disabled={!summary || busy}>
            {busy ? 'Deleting…' : 'Delete drive'}
          </button>
        </>
      )}
    >
      {!summary && !error && <p className="small muted" style={{ margin: 0 }} role="status">Checking what it holds…</p>}
      {summary && (
        <div className="stack" style={{ gap: 'var(--s2)' }}>
          {deleteDriveConsequence(summary).map((line) => <p key={line} className="small" style={{ margin: 0 }}>{line}</p>)}
        </div>
      )}
      {error && (
        <div className="stack" style={{ gap: 'var(--s2)', marginTop: summary ? 'var(--s3)' : 0 }}>
          <p className="small" role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p>
          {!summary && <div><button type="button" className="btn btn-sm" onClick={() => setAttempt((n) => n + 1)}>Try again</button></div>}
        </div>
      )}
    </Dialog>
  );
}
