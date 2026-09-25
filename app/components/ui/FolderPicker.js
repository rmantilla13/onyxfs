'use client';

import { useCallback, useMemo, useState } from 'react';
import Dialog from './Dialog';

// Rows drawn at once. A workspace with thousands of folders is searched, not
// scrolled, and the filter narrows it long before this matters.
const MAX_ROWS = 400;

/**
 * Choose a destination folder: the Move dialog for files and folders.
 *
 * useFolderPicker() returns a function resolving to the chosen folder path
 * ('' is the top level) or null when dismissed:
 *
 *   const to = await pick({ title: 'Move 3 files', folders, current: folder });
 *
 * `folders` is the tree the sidebar already has ({ folder, depth }), so this
 * costs no request. `exclude` hides a folder and everything beneath it — a
 * folder cannot move into itself.
 */
export function useFolderPicker() {
  const [state, setState] = useState(null);
  const pick = useCallback((opts = {}) => new Promise((resolve) => setState({ ...opts, resolve })), []);
  const settle = useCallback((value) => setState((s) => { s?.resolve(value); return null; }), []);
  const element = state ? <FolderPickerDialog {...state} onDone={settle} /> : null;
  return { pick, pickerElement: element };
}

function FolderPickerDialog({ title = 'Move to…', folders = [], exclude = null, current = null, confirmLabel = 'Move here', onDone }) {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = [{ folder: '', name: 'All files', depth: 0 }, ...folders.map((f) => ({ ...f, depth: f.depth || f.folder.split('/').length }))];
    return all.filter((f) => {
      if (exclude != null && exclude !== '' && (f.folder === exclude || f.folder.startsWith(`${exclude}/`))) return false;
      return !q || f.folder.toLowerCase().includes(q) || (f.folder === '' && 'all files'.includes(q));
    });
  }, [folders, exclude, query]);

  const shown = rows.slice(0, MAX_ROWS);
  const can = chosen !== null && chosen !== current;

  return (
    <Dialog
      open
      onClose={() => onDone(null)}
      title={title}
      footer={(
        <>
          <button className="btn" onClick={() => onDone(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={!can} onClick={() => onDone(chosen)}>{confirmLabel}</button>
        </>
      )}
    >
      <div className="stack" style={{ gap: 'var(--s2)' }}>
        <input
          className="input"
          placeholder="Find a folder…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Find a folder"
          autoFocus
        />
        <div className="picker-list" role="listbox" aria-label="Folders">
          {shown.map((f) => (
            <button
              key={f.folder || '/'}
              type="button"
              role="option"
              aria-selected={chosen === f.folder}
              disabled={f.folder === current}
              className={`picker-row small${chosen === f.folder ? ' active' : ''}`}
              style={{ paddingLeft: `calc(var(--s2) + ${query ? 0 : Math.max(0, f.depth - 1)} * var(--s3))` }}
              onClick={() => setChosen(f.folder)}
              onDoubleClick={() => f.folder !== current && onDone(f.folder)}
              title={f.folder || 'All files'}
            >
              <span className="truncate">{query && f.folder ? f.folder : (f.name || f.folder.slice(f.folder.lastIndexOf('/') + 1))}</span>
              {f.folder === current && <span className="muted"> · current</span>}
            </button>
          ))}
          {rows.length > MAX_ROWS && <div className="small muted" style={{ padding: 'var(--s2)' }}>{rows.length - MAX_ROWS} more — type to narrow</div>}
          {!rows.length && <div className="small muted" style={{ padding: 'var(--s2)' }}>No folder matches.</div>}
        </div>
      </div>
    </Dialog>
  );
}
