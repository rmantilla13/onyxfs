'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import FolderDrop, { startFolderDrag } from './FolderDrop';
import { folderKey } from '@/lib/selection';
import { overlaps } from '@/lib/marquee';
import FolderGlyph from '@/app/components/ui/FolderGlyph';
import { describeFolder } from '@/lib/folder-ops';

// Past this many subfolders the tree is the better way in; the items are not
// virtualized.
export const MAX_TILES = 300;

// The folder glyph on a card, by the view's card size.
const GLYPH = { s: 42, m: 58, l: 70 };


/**
 * The keyboard and the marquee's view of a set of folder items: which one
 * holds the tab stop (a roving tabindex, like the files: one stop for the
 * whole set rather than three hundred), how many columns they are laid out
 * in, how to focus one, and which ones a rectangle touches. Registered on
 * `navRef.current.folders` for the page (app/files/useSelectionModel.js).
 */
function useFolderNav({ folders, navRef, columns }) {
  const list = useRef(null);
  const [active, setActive] = useState(0);
  const [cols, setCols] = useState(1);
  const foldersRef = useRef(folders);
  foldersRef.current = folders;

  useEffect(() => {
    setActive((i) => Math.min(Math.max(0, i), Math.max(0, folders.length - 1)));
  }, [folders.length]);

  const measure = useCallback(() => {
    const el = list.current;
    if (!el || columns === 1) { setCols(1); return; }
    const n = Math.max(1, window.getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length);
    setCols((c) => (c === n ? c : n));
  }, [columns]);
  useLayoutEffect(() => { measure(); }, [measure, folders.length]);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !list.current) return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(list.current);
    return () => ro.disconnect();
  }, [measure]);

  const itemAt = (i) => {
    const f = foldersRef.current[i];
    return f && list.current ? list.current.querySelector(`[data-folder="${CSS.escape(f.folder)}"]`) : null;
  };
  const focus = useCallback((i, { scroll = true } = {}) => {
    const n = Math.min(foldersRef.current.length, MAX_TILES);
    if (!n) return;
    const next = Math.min(Math.max(0, i), n - 1);
    setActive(next);
    const el = itemAt(next);
    if (el) {
      el.focus({ preventScroll: true });
      if (scroll) el.scrollIntoView({ block: 'nearest' });
    }
  }, []);

  // Gone with the items: a stale registration would steer the keyboard into
  // folders that are no longer shown.
  useEffect(() => () => {
    if (navRef?.current?.folders?.focus === focus) delete navRef.current.folders;
  }, [navRef, focus]);

  if (navRef) {
    navRef.current.folders = {
      cols,
      focus,
      reveal: (i) => itemAt(i)?.scrollIntoView({ block: 'nearest' }),
      // Folder items are never virtualized, so the DOM can be asked.
      hits: (rect) => {
        const out = [];
        const items = list.current ? list.current.querySelectorAll('[data-folder]') : [];
        for (const el of items) {
          if (overlaps(el.getBoundingClientRect(), rect)) out.push(folderKey(el.getAttribute('data-folder')));
        }
        return out;
      },
    };
  }

  const onFocus = (e) => {
    const path = e.target?.closest?.('[data-folder]')?.getAttribute('data-folder');
    if (path == null) return;
    const i = foldersRef.current.findIndex((f) => f.folder === path);
    if (i >= 0) setActive((a) => (a === i ? a : i));
  };

  return { list, active, onFocus };
}

const FolderTile = memo(function FolderTile({ folder: f, detail, glyph, selected, tabbable, handlers, canWrite, onDrop }) {
  const key = folderKey(f.folder);
  return (
    <FolderDrop target={f.folder} enabled={canWrite} onDrop={onDrop} className="folder-tile-wrap">
      <div
        role="option"
        aria-selected={selected}
        tabIndex={tabbable ? 0 : -1}
        className="folder-tile"
        data-folder={f.folder}
        title={f.folder}
        onClick={(e) => handlers.click(e, key)}
        onDoubleClick={(e) => handlers.dblclick(e, key)}
        onKeyDown={(e) => handlers.keyDown(e, key)}
        draggable={canWrite}
        onDragStart={canWrite ? (e) => startFolderDrag(e, f.folder) : undefined}
      >
        <FolderGlyph size={glyph} className="folder-tile-icon" />
        <span className="folder-tile-text">
          <span className="folder-tile-name truncate">{f.name}</span>
          {detail && <span className="folder-tile-meta truncate">{detail}</span>}
        </span>
      </div>
    </FolderDrop>
  );
});

/**
 * The open folder's subfolders as cards above its files — larger than a
 * file's, with a solid folder where a file has its picture, so the two never
 * read as one kind of thing. They are items like the files: a click selects
 * (⌘ and ⇧ as for files), a double-click, Return, ⌘↓ or a tap opens, arrows
 * cross between them and the files. Each is a drop target for moves and
 * uploads, draggable onto another folder on its own, and carries data-folder
 * so the page's context menu finds it. `summaries` is folderSummaries().
 */
export const FolderTiles = memo(function FolderTiles({ folders, summaries, cardSize = 'm', selected, handlers, canWrite, onDrop, navRef }) {
  const shown = folders.slice(0, MAX_TILES);
  const { list, active, onFocus } = useFolderNav({ folders: shown, navRef });
  return (
    <div className="folder-tiles" role="listbox" aria-label="Folders" aria-multiselectable="true" ref={list} onFocus={onFocus}>
      {shown.map((f, i) => (
        <FolderTile
          key={f.folder}
          folder={f}
          detail={describeFolder(summaries?.get(f.folder))}
          glyph={GLYPH[cardSize] || GLYPH.m}
          selected={selected.has(f.folder)}
          tabbable={i === active}
          handlers={handlers}
          canWrite={canWrite}
          onDrop={onDrop}
        />
      ))}
      {folders.length > shown.length && (
        <p className="small muted" style={{ margin: 0, alignSelf: 'center' }} role="presentation">
          and {folders.length - shown.length} more in the sidebar
        </p>
      )}
    </div>
  );
});

/**
 * The list view's version of the folder tiles: the open folder's subfolders
 * as rows above its files, in the list's columns — a solid folder, the name
 * in semibold and a faint tint, so they read as folders before a word of
 * them is. Same behaviour as a tile. A folder has a size (what it holds)
 * and a type; the other columns are about files and stay empty.
 */
function folderCell(summary, c) {
  if (c.key === 'size') return describeFolder(summary, { short: true }) || '—';
  if (c.key === 'type') return 'Folder';
  return '';
}

const FolderRow = memo(function FolderRow({ folder: f, summary, columns, selected, tabbable, handlers, canWrite, onDrop }) {
  const key = folderKey(f.folder);
  return (
    <FolderDrop target={f.folder} enabled={canWrite} onDrop={onDrop}>
      <div
        role="option"
        aria-selected={selected}
        tabIndex={tabbable ? 0 : -1}
        className={`filelist-row filelist-cols filelist-folder${selected ? ' is-selected' : ''}`}
        data-folder={f.folder}
        title={f.folder}
        onClick={(e) => handlers.click(e, key)}
        onDoubleClick={(e) => handlers.dblclick(e, key)}
        onKeyDown={(e) => handlers.keyDown(e, key)}
        draggable={canWrite}
        onDragStart={canWrite ? (e) => startFolderDrag(e, f.folder) : undefined}
      >
        <span className="filelist-thumb filelist-folder-icon" aria-hidden><FolderGlyph size={24} /></span>
        <span className="filelist-name"><span className="truncate">{f.name}</span></span>
        {columns.map((c) => (
          <span key={c.key} className="filelist-cell muted truncate">{folderCell(summary, c)}</span>
        ))}
        <span aria-hidden />
      </div>
    </FolderDrop>
  );
});

export const FolderRows = memo(function FolderRows({ folders, summaries, columns, selected, handlers, canWrite, onDrop, navRef }) {
  const shown = folders.slice(0, MAX_TILES);
  const { list, active, onFocus } = useFolderNav({ folders: shown, navRef, columns: 1 });
  return (
    <div className="filelist-folders" role="listbox" aria-label="Folders" aria-multiselectable="true" ref={list} onFocus={onFocus}>
      {shown.map((f, i) => (
        <FolderRow
          key={f.folder}
          folder={f}
          summary={summaries?.get(f.folder)}
          columns={columns}
          selected={selected.has(f.folder)}
          tabbable={i === active}
          handlers={handlers}
          canWrite={canWrite}
          onDrop={onDrop}
        />
      ))}
      {folders.length > shown.length && (
        <p className="small muted filelist-more" role="presentation">and {folders.length - shown.length} more in the sidebar</p>
      )}
    </div>
  );
});
