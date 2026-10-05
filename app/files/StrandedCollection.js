'use client';

import { useState } from 'react';
import Dialog from '@/app/components/ui/Dialog';

/**
 * A collection made in All files while there is none (lib/collection-scope.js
 * isStranded): nobody can open it until it is in a drive. Offered to move
 * into the drive on screen, or to delete — to whoever may edit files, the
 * only people it is listed for.
 *
 * `driveName` is the drive on screen, and `canMove` whether a collection may
 * be made there. `onMove` and `onDelete` resolve once done; they own the
 * confirm, the request and what is said after.
 */
export default function StrandedCollection({ collection, driveName = '', canMove = false, onClose, onMove, onDelete }) {
  // Which is under way, 'move' or 'delete': either holds both buttons.
  const [busy, setBusy] = useState(null);
  const run = (which, act) => async () => {
    setBusy(which);
    try { await act(collection); } finally { setBusy(null); }
  };
  return (
    <Dialog
      open={!!collection}
      onClose={onClose}
      title={collection ? `“${collection.name}” is in no drive` : ''}
      footer={collection && (
        <>
          <button type="button" className="btn btn-danger collection-delete" onClick={run('delete', onDelete)} disabled={!!busy}>Delete</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          {canMove && driveName && (
            <button type="button" className="btn btn-primary" onClick={run('move', onMove)} disabled={!!busy}>
              {busy === 'move' ? 'Moving…' : `Move to ${driveName}`}
            </button>
          )}
        </>
      )}
    >
      {collection && (
        <p className="small" style={{ margin: 0 }}>
          It was made in All files, which is turned off now that files are kept in drives, so it cannot be opened.
          {canMove && driveName
            ? ` Move it into ${driveName} and it gathers that drive’s files by the same rules — or delete it if it was made again there.`
            : ' Open a drive you can edit to move it there, or delete it.'}
        </p>
      )}
    </Dialog>
  );
}
