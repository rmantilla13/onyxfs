'use client';

import { useCallback, useEffect, useState } from 'react';
import { deriveAuto } from '@/lib/dam';
import Dialog from '@/app/components/ui/Dialog';
import FileGrid from '@/app/components/ui/FileGrid';
import { fmtSize } from '@/app/components/ui/FileCard';
import { useToast } from '@/app/components/ui/Toast';
import { useConfirm } from '@/app/components/ui/Confirm';

/**
 * The trash: everything soft-deleted, with the two things you can do to it.
 *
 * GET /api/files/trash is not a plain read — it runs the retention sweep as a
 * side effect, permanently purging anything past the window. So it is called
 * on mount and on an explicit Refresh, and never after an action: a restore
 * or a purge already tells us which rows are gone, and dropping them locally
 * keeps one button press from costing one sweep.
 */
export default function TrashClient({ canWrite }) {
  const [files, setFiles] = useState([]);
  const [retentionDays, setRetentionDays] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  // The file open in the detail dialog. Trashed objects live under the trash
  // prefix, so /files/[id] would presign a key that is no longer there and
  // show a broken preview — the dialog uses the URLs this listing signed.
  const [preview, setPreview] = useState(null);

  const toast = useToast();
  const { confirm, confirmElement } = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/files/trash');
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Request failed (${r.status})`);
      const data = await r.json();
      setFiles(data.files || []);
      setRetentionDays(data.retentionDays ?? null);
      setSelected(new Set());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /**
   * Apply one action to a set of ids. The route takes a single id per call,
   * so a multi-select is a call each — and each is authorized on its own
   * server-side, which is why a partial failure (a file you can read but not
   * modify) has to be reported rather than assumed away.
   */
  const act = useCallback(async (ids, action) => {
    if (!ids.length || busy) return;
    setBusy(true);
    try {
      const results = await Promise.all(ids.map(async (id) => {
        try {
          const r = await fetch('/api/files/trash', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, action }),
          });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Request failed (${r.status})`);
          return { id, ok: true };
        } catch (e) {
          return { id, ok: false, error: e.message };
        }
      }));

      const done = new Set(results.filter((r) => r.ok).map((r) => r.id));
      const failed = results.filter((r) => !r.ok);
      if (done.size) {
        setFiles((prev) => prev.filter((f) => !done.has(f.id)));
        setSelected((prev) => new Set([...prev].filter((id) => !done.has(id))));
        setPreview((p) => (p && done.has(p.id) ? null : p));
      }

      const verb = action === 'restore' ? 'restored' : 'permanently deleted';
      if (done.size) toast.success(`${done.size} file${done.size === 1 ? '' : 's'} ${verb}.`);
      if (failed.length) {
        toast.error(`${failed.length} of ${results.length} could not be ${verb} — ${failed[0].error}`);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, toast]);

  // Restore is undoable by definition — delete it again. No confirm.
  const restore = useCallback((ids) => act(ids, 'restore'), [act]);

  const purge = useCallback(async (ids) => {
    if (!ids.length) return;
    const one = ids.length === 1 ? files.find((f) => f.id === ids[0]) : null;
    const ok = await confirm({
      title: one ? `Permanently delete “${one.name}”?` : `Permanently delete ${ids.length} files?`,
      body: 'The file and its thumbnail are erased from storage. This is not a second trash — there is nothing left to restore and no way to undo it.',
      confirmLabel: 'Delete permanently',
    });
    if (!ok) return;
    act(ids, 'purge');
  }, [act, confirm, files]);

  const toggleSelect = useCallback((f) => {
    setSelected((s) => {
      const n = new Set(s);
      n.has(f.id) ? n.delete(f.id) : n.add(f.id);
      return n;
    });
  }, []);

  const ids = [...selected];

  return (
    <main className="shell" style={{ padding: '24px 24px 64px' }}>
      <div className="row" style={{ marginBottom: files.length > 0 ? 6 : 20 }}>
        <h1 style={{ fontSize: 24 }}>Trash</h1>
        <span className="muted small">{files.length}</span>
        <div className="spacer" />
        {canWrite && selected.size > 0 && (
          <>
            <button className="btn" disabled={busy} onClick={() => restore(ids)}>
              Restore {selected.size}
            </button>
            <button className="btn btn-danger" disabled={busy} onClick={() => purge(ids)}>
              Delete permanently
            </button>
          </>
        )}
        <button className="btn btn-ghost btn-sm" disabled={loading || busy} onClick={load}>Refresh</button>
      </div>

      {/* The empty state explains the retention window at length, so this
          line only earns its space while there is something to act on. */}
      {files.length > 0 && (
        <p className="muted small" style={{ margin: '0 0 20px' }}>
          {retentionDays ? `Kept for ${retentionDays} days from the day you delete them. ` : ''}
          Select a card to act on it, or open one for a closer look.
        </p>
      )}

      {error && (
        <div className="card" style={{ padding: 16, marginBottom: 16, borderColor: 'var(--danger)' }}>
          <p className="small" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p>
        </div>
      )}

      {loading ? (
        <div className="empty">Loading…</div>
      ) : (
        <FileGrid
          label="Trashed files"
          files={files}
          selected={selected}
          onSelect={toggleSelect}
          onOpen={(f) => setPreview(f)}
          labelFor={(f) => deriveAuto(f).format || f.kind}
          badgesFor={(f) => <DaysLeft days={f.daysLeft} />}
          emptyState={(
            <div className="empty">
              Trash is empty. Files you delete are kept here for{' '}
              {retentionDays ? `${retentionDays} days` : 'a while'} so you can put them back,
              then they are purged for good.
            </div>
          )}
        />
      )}

      <Dialog
        open={!!preview}
        onClose={() => setPreview(null)}
        title={preview?.name}
        footer={canWrite && preview ? (
          <>
            <button className="btn" disabled={busy} onClick={() => restore([preview.id])}>Restore</button>
            <button className="btn btn-danger" disabled={busy} onClick={() => purge([preview.id])}>
              Delete permanently
            </button>
          </>
        ) : null}
      >
        {preview && <TrashDetail file={preview} />}
      </Dialog>

      {confirmElement}
    </main>
  );
}

/** How long is left before the sweep takes it. Loud in the last two days. */
function DaysLeft({ days }) {
  if (!Number.isFinite(days)) return null;
  const tone = days < 2 ? ' tag-danger' : days < 7 ? ' tag-warning' : '';
  return <span className={`tag${tone}`}>{days <= 0 ? 'Purging today' : `${days}d left`}</span>;
}

function TrashDetail({ file }) {
  // Same rule as the card: a video's poster is its thumbnail or nothing. The
  // original can be gigabytes and an <img> cannot show it anyway.
  const src = file.thumbnailUrl || (file.kind === 'image' ? file.url : null);
  return (
    <div className="stack">
      {src && (
        <img
          src={src}
          alt=""
          style={{
            width: '100%', maxHeight: 320, objectFit: 'contain',
            background: 'var(--surface-sunken)', borderRadius: 'var(--radius)',
          }}
        />
      )}
      <div className="stack" style={{ gap: 'var(--s1)' }}>
        <Fact label="Size" value={fmtSize(file.size) || '—'} />
        <Fact label="Folder" value={file.folder || '—'} />
        <Fact label="Deleted" value={fmtWhen(file.deletedAt)} />
        <Fact
          label="Purges"
          value={file.daysLeft > 0 ? `in ${file.daysLeft} day${file.daysLeft === 1 ? '' : 's'}` : 'today'}
        />
      </div>
    </div>
  );
}

function Fact({ label, value }) {
  return (
    <div className="row small">
      <span className="muted">{label}</span>
      <div className="spacer" />
      <span className="truncate" title={value}>{value}</span>
    </div>
  );
}

// deletedAt is epoch milliseconds, like every other timestamp in this API.
const fmtWhen = (ms) => (ms ? new Date(Number(ms)).toLocaleString() : '—');
