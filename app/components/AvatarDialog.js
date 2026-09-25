'use client';

import { useEffect, useRef, useState } from 'react';
import Dialog from '@/app/components/ui/Dialog';
import { initialsFor } from '@/lib/account';
import { avatarFileProblem } from '@/lib/avatars';

/**
 * Choose, change or remove your profile picture.
 *
 * The chosen file is previewed here as it will be shown — a circle, cropped
 * to fill it — and only sent on Save. The server re-encodes it
 * (/api/me/avatar), so what is stored is never the file itself; `onSaved`
 * gets the new URL (null after a removal) for the nav to show at once.
 */
export default function AvatarDialog({ open, onClose, email, current, onSaved }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const input = useRef(null);

  useEffect(() => {
    if (!open) return;
    setFile(null); setPreview(null); setError(null); setBusy(null);
  }, [open]);

  // The preview is an object URL: let it go when it is replaced or the dialog shuts.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const choose = (f) => {
    const problem = avatarFileProblem(f);
    if (problem) { setError(problem); return; }
    setError(null);
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };

  const save = async () => {
    if (!file || busy) return;
    setBusy('save'); setError(null);
    try {
      const r = await fetch('/api/me/avatar', { method: 'PUT', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { setError(body.error || `Could not save the picture (HTTP ${r.status}).`); return; }
      onSaved?.(body.url);
      onClose?.();
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy('remove'); setError(null);
    try {
      const r = await fetch('/api/me/avatar', { method: 'DELETE' });
      if (!r.ok) { setError(`Could not remove the picture (HTTP ${r.status}).`); return; }
      onSaved?.(null);
      onClose?.();
    } finally {
      setBusy(null);
    }
  };

  const shown = preview || current;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Profile picture"
      footer={(
        <>
          {current && !preview && (
            <button type="button" className="btn btn-ghost" onClick={remove} disabled={!!busy}>
              {busy === 'remove' ? 'Removing…' : 'Remove picture'}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={!file || !!busy}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </>
      )}
    >
      <div className="avatar-edit">
        <span className="avatar avatar-lg" aria-hidden>
          {shown ? <img src={shown} alt="" /> : initialsFor(email)}
        </span>
        <div className="stack" style={{ gap: 'var(--s2)', minWidth: 0 }}>
          <p className="small muted" style={{ margin: 0 }}>
            Shown in the top bar. JPEG, PNG, WebP or GIF, up to 8 MB — it is cropped to a circle around what matters in it.
          </p>
          <div className="row" style={{ gap: 'var(--s2)' }}>
            <button type="button" className="btn" onClick={() => input.current?.click()} disabled={!!busy}>
              {shown ? 'Choose another…' : 'Choose a picture…'}
            </button>
          </div>
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            hidden
            onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ''; }}
          />
          {error && <p className="small" role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p>}
        </div>
      </div>
    </Dialog>
  );
}
