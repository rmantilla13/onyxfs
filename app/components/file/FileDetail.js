'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import FilePreview from './FilePreview';
import Dialog from '@/app/components/ui/Dialog';
import Menu, { MenuItem, MenuSeparator } from '@/app/components/ui/Menu';
import { Panel, Field } from '@/app/components/ui/Layout';
import { useToast } from '@/app/components/ui/Toast';
import { useConfirm } from '@/app/components/ui/Confirm';
import { fmtSize } from '@/app/components/ui/FileCard';
import { deriveAuto } from '@/lib/dam';
import ShareDialog from '@/app/components/ShareDialog';

/**
 * The file detail view: preview on the left, inspector on the right.
 *
 * Written container-agnostic — it takes a file and renders — so the same
 * component can serve the standalone /files/[id] page and, later, an
 * intercepted modal over the grid without being rewritten.
 *
 * `canWrite` comes from the server, which has already decided; the controls
 * are hidden rather than rendered into a 403. The server check is still the
 * one that counts.
 */
export default function FileDetail({ file: initial, canWrite = false, canShare = false, backHref = '/files', startAt = 0 }) {
  const [file, setFile] = useState(initial);
  const [sharing, setSharing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(initial.name || '');
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const toast = useToast();
  const { confirm, confirmElement } = useConfirm();

  const auto = deriveAuto(file);

  const patch = useCallback(async (body, okMessage) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/files/${file.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || `Request failed (${r.status})`);
      // PATCH returns the row unsigned, so keep the presigned url we already
      // hold rather than replacing it with the stored one and breaking the
      // preview.
      setFile((f) => ({ ...f, ...out.file, url: f.url, thumbnailUrl: f.thumbnailUrl }));
      if (okMessage) toast.success(okMessage);
      router.refresh();
      return true;
    } catch (e) {
      toast.error(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }, [file.id, router, toast]);

  const rename = async () => {
    const next = name.trim();
    if (!next || next === file.name) { setRenaming(false); return; }
    if (await patch({ name: next }, 'Renamed.')) setRenaming(false);
  };

  const trash = async () => {
    const ok = await confirm({
      title: `Move “${file.name}” to trash?`,
      body: 'Trashed files are kept for 30 days before they are purged.',
      confirmLabel: 'Move to trash',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/files/${file.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not trash this file.');
      toast.success('Moved to trash.');
      router.push(backHref);
      router.refresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="shell file-detail" style={{ padding: 'var(--s5) var(--s5) 64px' }}>
      <div className="row" style={{ marginBottom: 'var(--s4)' }}>
        <a className="btn btn-ghost btn-sm" href={backHref}>← Back</a>
        <h1 className="truncate" style={{ fontSize: 'var(--t-xl)', minWidth: 0 }} title={file.name}>{file.name}</h1>
        <div className="spacer" />
        {canShare && <button type="button" className="btn" onClick={() => setSharing(true)}>Share</button>}
        <a className="btn" href={`/api/files/${file.id}/download`}>Download</a>
        {canWrite && (
          <Menu label="File actions">
            <MenuItem onClick={() => { setName(file.name); setRenaming(true); }}>Rename…</MenuItem>
            <MenuSeparator />
            <MenuItem danger onClick={trash}>Move to trash</MenuItem>
          </Menu>
        )}
      </div>

      <div className="file-detail-body">
        <div style={{ minWidth: 0 }}>
          <FilePreview file={file} startAt={startAt} />
        </div>

        <aside style={{ minWidth: 0 }}>
          <Panel title="Details">
            <dl className="detail-list">
              <Row label="Kind">{auto.format || file.kind}</Row>
              <Row label="Size">{fmtSize(file.size) || '—'}</Row>
              {file.metadata?.width && file.metadata?.height && (
                <Row label="Dimensions">
                  {file.metadata.width} × {file.metadata.height}
                  {auto.aspect_ratio ? ` · ${auto.aspect_ratio}` : ''}
                </Row>
              )}
              <Row label="Folder">{file.folder || 'All files'}</Row>
              <Row label="Added">{file.createdAt ? new Date(file.createdAt).toLocaleString() : '—'}</Row>
              <Row label="Added by">{file.createdBy || '—'}</Row>
              {file.tags?.length > 0 && (
                <Row label="Tags">
                  <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                    {file.tags.map((t) => <span key={t} className="tag">{t}</span>)}
                  </span>
                </Row>
              )}
            </dl>
          </Panel>
        </aside>
      </div>

      <Dialog
        open={renaming}
        onClose={() => setRenaming(false)}
        title="Rename file"
        footer={(
          <>
            <button className="btn" onClick={() => setRenaming(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={rename} disabled={busy}>{busy ? 'Saving…' : 'Rename'}</button>
          </>
        )}
      >
        <Field label="Name">
          <input
            className="input"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); rename(); } }}
          />
        </Field>
      </Dialog>

      {canShare && <ShareDialog file={file} open={sharing} onClose={() => setSharing(false)} />}
      {confirmElement}
    </main>
  );
}

function Row({ label, children }) {
  return (
    <>
      <dt className="small muted">{label}</dt>
      <dd className="small" style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>{children}</dd>
    </>
  );
}
