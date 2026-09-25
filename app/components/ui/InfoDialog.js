'use client';

import Dialog from './Dialog';
import { Thumb, fmtSize } from './FileCard';
import { fileFacts, selectionFacts, kindLabel } from '@/lib/file-info';
import { crumbsFor, baseName } from '@/lib/folder-ops';
import { fmtDuration } from '@/lib/media';

/**
 * "Get info", the way a file manager has it: one file, several, or a folder.
 *
 *   { type: 'file', file }
 *   { type: 'files', files }
 *   { type: 'folder', path, stats }   stats from folderStats (lib/folder-ops)
 *
 * Read-only, and built from what the page already holds, so it opens at once
 * and says nothing the viewer could not already see in the list.
 */
const dateTime = typeof Intl !== 'undefined'
  ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  : null;
const dateOnly = typeof Intl !== 'undefined'
  ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
  : null;
const bytesFmt = typeof Intl !== 'undefined' ? new Intl.NumberFormat() : null;

function Where({ path, onOpenFolder }) {
  const label = crumbsFor(path).map((c) => c.name).join(' / ');
  if (!onOpenFolder) return <span>{label}</span>;
  return (
    <button type="button" className="info-link" onClick={() => onOpenFolder(path)} title={`Open ${path || 'All files'}`}>
      {label}
    </button>
  );
}

function Value({ row, onOpenFolder }) {
  switch (row.type) {
    case 'bytes':
      return (
        <span>
          {fmtSize(row.value) || '0 B'}
          {row.value >= 1024 && bytesFmt && <span className="muted"> ({bytesFmt.format(row.value)} bytes)</span>}
        </span>
      );
    case 'date':
      return <span>{dateTime ? dateTime.format(new Date(Number(row.value))) : String(row.value)}</span>;
    case 'day': {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(row.value);
      return <span>{m && dateOnly ? dateOnly.format(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : row.value}</span>;
    }
    case 'seconds':
      return <span>{fmtDuration(row.value)}</span>;
    case 'list':
      return (
        <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
          {row.value.map((v) => <span key={v} className="tag">{v}</span>)}
        </span>
      );
    case 'folder':
      return <Where path={row.value} onOpenFolder={onOpenFolder} />;
    default:
      return <span className="info-text">{row.value}</span>;
  }
}

function Facts({ rows, onOpenFolder }) {
  return (
    <dl className="info-list">
      {rows.map((r) => (
        <div key={r.key} className="info-row">
          <dt className="muted">{r.label}</dt>
          <dd><Value row={r} onOpenFolder={onOpenFolder} /></dd>
        </div>
      ))}
    </dl>
  );
}

const FolderIcon = () => (
  <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden>
    <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.3l2 2h8.7A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
  </svg>
);

export default function InfoDialog({ info, schema, onClose, onOpenFile, onDownload, onOpenFolder }) {
  if (!info) return null;
  const close = () => onClose?.();
  // Leaving the dialog to go somewhere closes it first, so it is not left
  // open over the place it sent you.
  const go = (fn) => (...args) => { close(); fn?.(...args); };

  if (info.type === 'file') {
    const f = info.file;
    return (
      <Dialog
        open
        onClose={close}
        title="Info"
        footer={(
          <>
            {onDownload && <button type="button" className="btn" onClick={go(() => onDownload(f))}>Download</button>}
            {onOpenFile && <button type="button" className="btn btn-primary" onClick={go(() => onOpenFile(f))}>Open</button>}
          </>
        )}
      >
        <div className="info-head">
          <span className="info-thumb"><Thumb file={f} label={kindLabel(f)} /></span>
          <div style={{ minWidth: 0 }}>
            <p className="info-name" title={f.name}>{f.name}</p>
            <p className="small muted" style={{ margin: 0 }}>{kindLabel(f)}{f.size != null ? ` · ${fmtSize(f.size)}` : ''}</p>
          </div>
        </div>
        <Facts rows={fileFacts(f, schema)} onOpenFolder={onOpenFolder && go(onOpenFolder)} />
      </Dialog>
    );
  }

  if (info.type === 'files') {
    const s = selectionFacts(info.files);
    return (
      <Dialog open onClose={close} title="Info" footer={<button type="button" className="btn btn-primary" onClick={close}>Done</button>}>
        <div className="info-head">
          <span className="info-thumb info-stack" aria-hidden>
            {info.files.slice(0, 3).map((f) => <Thumb key={f.id} file={f} label="" />)}
          </span>
          <div style={{ minWidth: 0 }}>
            <p className="info-name">{s.count} files</p>
            <p className="small muted" style={{ margin: 0 }}>{fmtSize(s.bytes) || '0 B'} in all</p>
          </div>
        </div>
        <Facts
          onOpenFolder={onOpenFolder && go(onOpenFolder)}
          rows={[
            { key: 'size', label: 'Size', type: 'bytes', value: s.bytes },
            { key: 'kinds', label: 'Kinds', type: 'text', value: s.kinds.map((k) => `${k.count} ${k.label}`).join(', ') },
            ...(s.folders.length === 1
              ? [{ key: 'where', label: 'Where', type: 'folder', value: s.folders[0] }]
              : [{ key: 'where', label: 'Where', type: 'text', value: `${s.folders.length} folders` }]),
          ]}
        />
      </Dialog>
    );
  }

  // A folder, or the library itself when the path is empty.
  const { path, stats } = info;
  const name = path ? baseName(path) : 'All files';
  const rows = [
    ...(path ? [{ key: 'where', label: 'Where', type: 'folder', value: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '' }] : []),
    ...(stats.files != null ? [{ key: 'files', label: 'Files', type: 'text', value: String(stats.files) }] : []),
    { key: 'subfolders', label: 'Folders', type: 'text', value: String(path ? stats.subfolders : stats.nested) },
    ...(path && stats.nested > stats.subfolders
      ? [{ key: 'nested', label: 'In all', type: 'text', value: `${stats.total} file${stats.total === 1 ? '' : 's'} in ${stats.nested} folder${stats.nested === 1 ? '' : 's'}` }]
      : []),
    ...(!path ? [{ key: 'total', label: 'In folders', type: 'text', value: `${stats.total} file${stats.total === 1 ? '' : 's'}` }] : []),
  ];
  return (
    <Dialog
      open
      onClose={close}
      title="Info"
      footer={onOpenFolder && info.canOpen !== false
        ? <button type="button" className="btn btn-primary" onClick={go(() => onOpenFolder(path))}>Open</button>
        : <button type="button" className="btn btn-primary" onClick={close}>Done</button>}
    >
      <div className="info-head">
        <span className="info-thumb info-folder"><FolderIcon /></span>
        <div style={{ minWidth: 0 }}>
          <p className="info-name" title={path || name}>{name}</p>
          <p className="small muted" style={{ margin: 0 }}>{path ? 'Folder' : 'Library'}</p>
        </div>
      </div>
      <Facts rows={rows} onOpenFolder={onOpenFolder && go(onOpenFolder)} />
    </Dialog>
  );
}
