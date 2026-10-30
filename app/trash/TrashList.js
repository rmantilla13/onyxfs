'use client';

import { useCallback, useEffect, useState } from 'react';
import Icon from '@/app/components/ui/Icon';
import { useToast } from '@/app/components/ui/Toast';
import { fmtSize } from '@/lib/media';
import { relativeTime } from '@/lib/admin-format';

const KIND_ICON = { image: 'image', video: 'film', audio: 'audio-lines', doc: 'file-text' };
// What POST /api/files/trash/restore takes at once.
const RESTORE_BATCH = 200;
const DAY = 24 * 60 * 60 * 1000;

/** "Footage › Cuts", "Footage", or the folder alone outside every drive. */
function whereOf(f) {
  const parts = [f.drive?.name, ...(f.folder ? f.folder.split('/') : [])].filter(Boolean);
  return parts.length ? parts.join(' › ') : 'All files';
}

/** Where a restored file is in Files: its drive, at its folder. */
function filesHref(f) {
  const q = new URLSearchParams();
  if (f.drive?.id) q.set('filespace', f.drive.id);
  if (f.folder) q.set('folder', f.folder);
  const s = q.toString();
  return s ? `/files?${s}` : '/files';
}

function goneIn(purgesAt, now) {
  const days = Math.ceil((Number(purgesAt) - now) / DAY);
  if (!Number.isFinite(days)) return '';
  if (days <= 0) return 'Deleted for good today';
  return `Deleted for good in ${days} day${days === 1 ? '' : 's'}`;
}

/**
 * The Trash page's list (app/trash/page.js): the deleted files this person
 * may put back (GET /api/files/trash), newest first, a page at a time. Each
 * says where it was, who deleted it and when, and when it goes for good;
 * Restore puts the ticked ones — or one — back where they were
 * (POST /api/files/trash/restore), beside any newer file that took the name.
 */
export default function TrashList({ viewer = '', retentionDays = 30 }) {
  const toast = useToast();
  const [files, setFiles] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async (after = null) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/files/trash${after ? `?cursor=${encodeURIComponent(after)}` : ''}`, { cache: 'no-store' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `The trash could not be read (HTTP ${r.status}).`);
      setFiles((prev) => (after ? [...prev, ...(body.files || [])] : body.files || []));
      setCursor(body.cursor || null);
      setNow(Date.now());
    } catch (e) {
      setError(e.message || 'The trash could not be read.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = (id) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allTicked = files.length > 0 && files.every((f) => selected.has(f.id));
  const toggleAll = () => setSelected(allTicked ? new Set() : new Set(files.map((f) => f.id)));

  const restore = async (ids) => {
    if (!ids.length || busy) return;
    setBusy(true);
    const back = [];
    const left = [];
    let failed = 0;
    let firstError = null;
    try {
      for (let i = 0; i < ids.length; i += RESTORE_BATCH) {
        const batch = ids.slice(i, i + RESTORE_BATCH);
        const r = await fetch('/api/files/trash/restore', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ids: batch }),
        }).catch(() => null);
        const body = await r?.json().catch(() => ({}));
        if (!r?.ok) { failed += batch.length; firstError ||= body?.error || 'Could not reach Onyx.'; continue; }
        for (const x of body.restored || []) {
          if (x.restored) back.push(x); else left.push(x.id);
        }
        left.push(...(body.notInTrash || []));
        failed += (body.failed || []).length;
        firstError ||= body.failed?.[0]?.error || null;
      }
    } finally {
      setBusy(false);
    }
    // Gone from the list once back — and one that had already left the trash
    // (restored elsewhere, or purged) goes too: it is not here to restore.
    const answered = new Set([...back.map((x) => x.id), ...left]);
    setFiles((prev) => prev.filter((f) => !answered.has(f.id)));
    setSelected((s) => { const next = new Set(s); answered.forEach((id) => next.delete(id)); return next; });
    if (failed) toast.error(`${failed} of ${ids.length} could not be restored.${firstError ? ` ${firstError}` : ''}`);
    if (back.length) {
      const one = back.length === 1 ? files.find((f) => f.id === back[0].id) : null;
      const renamed = back.filter((x) => x.movedTo).length;
      // A newer file took the name meanwhile: it came back beside it, renamed.
      const words = one
        ? (renamed ? `Restored as “${back[0].name}”: a newer file has its old name.` : `Restored “${back[0].name}”.`)
        : `Restored ${back.length} files.${renamed ? ` ${renamed} came back renamed, as newer files have their names.` : ''}`;
      toast.success(words, one
        ? { action: { label: 'Show', onClick: () => { window.location.href = filesHref(one); } } }
        : undefined);
    }
  };

  const ticked = files.filter((f) => selected.has(f.id)).map((f) => f.id);
  const me = String(viewer || '').toLowerCase();

  return (
    <main className="trash-page">
      <header className="trash-head">
        <div>
          <h1 className="trash-title">Trash</h1>
          <p className="small muted trash-sub">
            Deleted files stay here for {retentionDays} days, then they’re deleted for good.
          </p>
        </div>
        {files.length > 0 && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!ticked.length || busy}
            onClick={() => restore(ticked)}
          >
            <Icon name="undo-2" size={14} />
            {ticked.length ? `Restore ${ticked.length.toLocaleString()}` : 'Restore'}
          </button>
        )}
      </header>

      {error && (
        <div className="trash-problem" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-sm" onClick={() => load()}>
            <Icon name="refresh-cw" size={14} />
            Try again
          </button>
        </div>
      )}

      {!error && !loading && files.length === 0 && (
        <div className="trash-empty">
          <Icon name="trash" size={28} />
          <p>Trash is empty.</p>
          <p className="small muted">Files you delete wait here for {retentionDays} days, in case you want them back.</p>
          <a className="btn btn-sm" href="/files">Back to Files</a>
        </div>
      )}

      {files.length > 0 && (
        <div className="trash-list" role="list" aria-busy={busy || loading}>
          <div className="trash-row trash-row-head">
            <input
              type="checkbox"
              checked={allTicked}
              onChange={toggleAll}
              aria-label={allTicked ? 'Select none' : 'Select all'}
            />
            <span className="small muted">Name</span>
            <span className="small muted trash-col-when">Deleted</span>
            <span className="small muted trash-col-size">Size</span>
            <span />
          </div>
          {files.map((f) => {
            const by = f.deletedBy ? (String(f.deletedBy).toLowerCase() === me ? 'you' : f.deletedBy) : null;
            return (
              <div key={f.id} className={`trash-row${selected.has(f.id) ? ' is-selected' : ''}`} role="listitem">
                <input
                  type="checkbox"
                  checked={selected.has(f.id)}
                  onChange={() => toggle(f.id)}
                  aria-label={`Select “${f.name}”`}
                />
                <span className="trash-name">
                  <Icon name={KIND_ICON[f.kind] || 'file'} size={16} /* icons: image film audio-lines file-text file */ />
                  <span className="trash-name-text">
                    <span className="truncate">{f.name}</span>
                    <span className="small muted truncate">{whereOf(f)}</span>
                  </span>
                </span>
                <span className="trash-col-when">
                  <span className="small">{relativeTime(f.deletedAt, now)}{by ? ` by ${by}` : ''}</span>
                  <span className="small muted">{goneIn(f.purgesAt, now)}</span>
                </span>
                <span className="small muted trash-col-size">{fmtSize(f.size) || '—'}</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => restore([f.id])}
                  aria-label={`Restore “${f.name}”`}
                >
                  Restore
                </button>
              </div>
            );
          })}
        </div>
      )}

      {cursor && !error && (
        <div className="trash-more">
          <button type="button" className="btn btn-sm" disabled={loading} onClick={() => load(cursor)}>
            {loading ? 'Loading…' : 'Show more'}
          </button>
        </div>
      )}
      {loading && files.length === 0 && !error && <p className="small muted trash-loading">Loading…</p>}
    </main>
  );
}
