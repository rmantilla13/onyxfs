'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Dialog from '@/app/components/ui/Dialog';
import { useToast } from '@/app/components/ui/Toast';
import { claimDrivesConfirm, claimedDrivesMessage } from '@/lib/admin-drives';
import { api } from '../_ui/api';

/**
 * "Make me the owner…": the fix for drives with no owner, beside the
 * warning on Admin → Overview and on Drives. `drives` is [{ id, name }].
 *
 * One click and a confirm that names every drive it changes; then the
 * route (POST /api/admin/filespaces/claim) makes this admin the owner of
 * those still without one, and the page is read again. Not a destructive
 * act — nobody loses anything, and nobody's access changes — so the confirm
 * is an ordinary one, with the primary button and the backdrop to dismiss it.
 */
export default function ClaimDrives({ drives = [] }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!drives.length) return null;
  const ask = claimDrivesConfirm(drives);

  const close = () => { if (!busy) setOpen(false); };
  const claim = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api('/api/admin/filespaces/claim', { method: 'POST', json: { ids: drives.map((d) => d.id) } });
      setOpen(false);
      toast.success(claimedDrivesMessage(result));
      router.refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="btn btn-sm btn-primary" onClick={() => { setError(null); setOpen(true); }}>
        Make me the owner…
      </button>
      <Dialog
        open={open}
        onClose={close}
        // While the answer is on its way the dialog stays, so a failure is
        // shown where the question was rather than after it has gone.
        dismissable={!busy}
        onEscape={close}
        title={ask.title}
        footer={(
          <>
            <button type="button" className="btn" onClick={close} disabled={busy}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={claim} disabled={busy}>
              {busy ? 'Saving…' : ask.confirmLabel}
            </button>
          </>
        )}
      >
        <div className="admin-lines">
          {ask.lead && <p className="small admin-note">{ask.lead}</p>}
          {ask.names.length > 0 && (
            <ul className="admin-name-list small">
              {ask.names.map((name, i) => <li key={drives[i].id}>{name}</li>)}
            </ul>
          )}
          {ask.lines.map((line) => <p key={line} className="small muted admin-note">{line}</p>)}
          {error && <p className="small admin-inline-error" role="alert">{error}</p>}
        </div>
      </Dialog>
    </>
  );
}
