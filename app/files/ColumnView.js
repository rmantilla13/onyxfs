'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import FolderDrop, { startFolderDrag } from './FolderDrop';
import FolderGlyph from '@/app/components/ui/FolderGlyph';
import { Thumb } from '@/app/components/ui/FileCard';
import { FieldLine, When, fieldValue } from '@/app/components/ui/FieldValue';
import Icon from '@/app/components/ui/Icon';
import { fileKey, folderKey } from '@/lib/selection';
import { overlaps } from '@/lib/marquee';
import { baseName } from '@/lib/folder-ops';
import { kindLabel } from '@/lib/file-info';
import { MAX_TILES } from './FolderItems';

/**
 * The Column layout: Finder's column browser. One column per folder from
 * the top of the drive down to the open one, each listing its folders and
 * then its files; to the right of the open folder, whatever is selected in
 * it — a folder's contents, or a file's details.
 *
 * The open folder's column is the page's listing, with the page's selection
 * model behind it (`handlers`, `navRef`), so a click, ⇧ and ⌘, Space, Return
 * and ↑ ↓ do what they do in every other layout, and so do the context menu,
 * drag and drop and the marquee. → opens the selected folder and ← goes up
 * to the enclosing one, landing on the folder it came out of, as Finder's
 * arrows do. The other columns are the way there: a click in one opens that
 * folder with the item selected (`onNavigate`), a double-click opens the
 * item itself.
 *
 * The other columns' files are asked for with the view's own kinds and sort
 * (`loadColumn`, from the listing cache when it has them) and filtered by
 * its facets (`matches`); only a first page each — past it the column says
 * there is more, and opening the folder lists it all.
 */

const COL_W = { s: 220, m: 260, l: 320 };

/** A row's picture: the folder glyph, or the file's own smallest thumbnail. */
function RowIcon({ file, labelFor }) {
  if (!file) return <FolderGlyph size={18} className="col-glyph" />;
  return (
    <span className="col-thumb" aria-hidden>
      <Thumb file={file} label={labelFor?.(file)} surface="row" />
    </span>
  );
}

/** A column that is a way there, not the open folder: plain buttons. */
const PathColumn = memo(function PathColumn({
  path, rootName, folders, files, more, openChild, onNavigate, onOpenFolder, onOpenFile, canWrite, onDrop, labelFor, width,
}) {
  const title = path ? baseName(path) : rootName;
  return (
    <div className="col" role="group" aria-label={title} style={{ width }}>
      {folders.map((f) => {
        const key = folderKey(f.folder);
        const open = f.folder === openChild;
        return (
          <FolderDrop key={f.folder} target={f.folder} enabled={canWrite} onDrop={onDrop}>
            <button
              type="button"
              className={`col-row is-folder${open ? ' is-open' : ''}`}
              data-col-folder={f.folder}
              title={f.folder}
              onClick={() => onNavigate(path, key)}
              onDoubleClick={() => onOpenFolder(f.folder)}
            >
              <RowIcon />
              <span className="col-name truncate">{f.name}</span>
              <Icon name="chevron-right" size={14} className="col-chevron" />
            </button>
          </FolderDrop>
        );
      })}
      {(files || []).map((f) => {
        const key = fileKey(f.id);
        return (
          <button
            key={f.id}
            type="button"
            className="col-row"
            title={f.name}
            onClick={() => onNavigate(path, key)}
            onDoubleClick={() => onOpenFile(f)}
          >
            <RowIcon file={f} labelFor={labelFor} />
            <span className="col-name truncate">{f.name}</span>
          </button>
        );
      })}
      {files === null && <p className="col-note small muted">Loading…</p>}
      {more && <p className="col-note small muted">More in this folder: open it to see them all.</p>}
      {files && !files.length && !folders.length && <p className="col-note small muted">Nothing here</p>}
    </div>
  );
});

/** A file's details, beside the column it was selected in. */
function Details({ file, fields, rootName, labelFor, onOpenFile, width }) {
  const md = file.metadata || {};
  const facts = [
    ['Kind', kindLabel(file)],
    ['Size', fieldValue(file, { key: 'size' })],
    ['Dimensions', md.width && md.height ? `${md.width} × ${md.height}` : ''],
    ['Duration', fieldValue(file, { key: 'duration' })],
    ['Created', file.createdAt ? <When at={file.createdAt} /> : ''],
    ['Modified', file.updatedAt ? <When at={file.updatedAt} /> : ''],
    ['Created by', file.createdBy || ''],
    ['Folder', file.folder || rootName],
  ].filter(([, v]) => v);
  return (
    <aside className="col col-details" aria-label={`About ${file.name}`} style={{ width: Math.max(width, 280) }}>
      <div className="col-preview">
        <Thumb file={file} label={labelFor?.(file)} surface="info" />
      </div>
      <h2 className="col-details-name" title={file.name}>{file.name}</h2>
      {fields?.length > 0 && <FieldLine file={file} fields={fields} rootName={rootName} className="field-line small muted" />}
      <dl className="col-facts">
        {facts.map(([k, v]) => (
          <div key={k} className="col-fact">
            <dt className="muted">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <button type="button" className="btn btn-sm col-open" onClick={() => onOpenFile(file)}>
        <Icon name="eye" size={14} />Open
      </button>
    </aside>
  );
}

function ColumnView({
  folder, rootName, tree, itemFolders, files, more, onLoadMore, pending = false,
  selected, selectedFolders, handlers, navRef, marqueeRef,
  loadColumn, columnKey, matches,
  onNavigate, onOpenFolder, onGoUp, onOpenFile,
  canWrite, onDrop, labelFor, badgesFor, onMissingThumb, fields, cardSize = 'm', emptyText = 'Nothing here',
}) {
  const width = COL_W[cardSize] || COL_W.m;
  const box = useRef(null);
  const current = useRef(null);
  const sentinel = useRef(null);
  const [height, setHeight] = useState(null);
  const [active, setActive] = useState(0);
  const filesRef = useRef(files);
  filesRef.current = files;
  const foldersRef = useRef(itemFolders);
  foldersRef.current = itemFolders;

  // Each folder's subfolders, from the tree. A folder shared on its own
  // arrives without its parent and sits at the top, as in the sidebar.
  const children = useMemo(() => {
    const paths = new Set(tree.map((f) => f.folder));
    const by = new Map();
    for (const f of tree) {
      if (!f.folder) continue;
      const parent = paths.has(f.parent) ? f.parent : '';
      if (!by.has(parent)) by.set(parent, []);
      by.get(parent).push(f);
    }
    return by;
  }, [tree]);

  // The way down: the top, each folder above the open one, the open one.
  const path = useMemo(() => {
    const parts = folder ? folder.split('/') : [];
    return ['', ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))];
  }, [folder]);
  const ancestors = useMemo(() => path.slice(0, -1), [path]);
  const onlyFolder = selectedFolders.size === 1 && selected.size === 0 ? [...selectedFolders][0] : null;
  const onlyFile = selected.size === 1 && selectedFolders.size === 0 ? files.find((f) => selected.has(f.id)) : null;

  // The other columns' files: loaded as they are needed, each asked for
  // once per listing — `columnKey` changes with the view's kinds and sort,
  // and when files change under the page, and starts afresh. An answer
  // that arrives after the key moved on lands under the old key, unread.
  const [loaded, setLoaded] = useState({});
  const asked = useRef(new Set());
  const wanted = useMemo(() => [...ancestors, ...(onlyFolder != null ? [onlyFolder] : [])], [ancestors, onlyFolder]);
  useEffect(() => {
    for (const p of wanted) {
      const k = `${columnKey}\u0000${p}`;
      if (asked.current.has(k)) continue;
      asked.current.add(k);
      setLoaded((prev) => ({ ...prev, [k]: null }));
      loadColumn(p).then(
        (res) => setLoaded((prev) => ({ ...prev, [k]: res })),
        () => setLoaded((prev) => ({ ...prev, [k]: { files: [], more: false } })),
      );
    }
  }, [wanted, columnKey, loadColumn]);
  // null while a column's files are on their way.
  const filesOf = (p) => {
    const res = loaded[`${columnKey}\u0000${p}`];
    if (!res) return { files: null, more: false };
    return { files: matches ? res.files.filter(matches) : res.files, more: res.more };
  };

  // As tall as the window leaves below the toolbar, so each column scrolls
  // on its own and the page does not.
  useLayoutEffect(() => {
    const fit = () => {
      const el = box.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      setHeight(Math.max(360, Math.round(window.innerHeight - top - 24)));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  // The newest column in view: the open folder's, or what it shows.
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
  }, [folder, onlyFolder, onlyFile?.id]);

  // More of the open folder, near the bottom of its column.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more || !onLoadMore) return undefined;
    // On a phone the column is the page's height and the page scrolls.
    const col = current.current;
    const root = col && col.scrollHeight > col.clientHeight + 1 ? col : null;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) onLoadMore(); }, { root, rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [more, onLoadMore, files.length]);

  // ── The open folder's column, for the keyboard and the marquee ───────────
  const shownFolders = itemFolders.slice(0, MAX_TILES);
  const order = useMemo(() => [...shownFolders.map((f) => folderKey(f.folder)), ...files.map((f) => fileKey(f.id))], [shownFolders, files]);
  useEffect(() => { setActive((i) => Math.min(Math.max(0, i), Math.max(0, order.length - 1))); }, [order.length]);
  const rowFor = (key) => current.current?.querySelector(key.startsWith('d:')
    ? `[data-folder="${CSS.escape(key.slice(2))}"]`
    : `[data-file-id="${CSS.escape(key.slice(2))}"]`);
  const focusKey = useCallback((key, { scroll = true } = {}) => {
    const i = order.indexOf(key);
    if (i >= 0) setActive(i);
    const el = rowFor(key);
    if (!el) return;
    el.focus({ preventScroll: true });
    if (scroll) el.scrollIntoView({ block: 'nearest' });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order]);
  const registered = useRef({});
  if (navRef) {
    const hits = (rect, attr) => {
      const out = [];
      for (const el of current.current?.querySelectorAll(`[${attr}]`) || []) {
        if (overlaps(el.getBoundingClientRect(), rect)) out.push(el.getAttribute(attr));
      }
      return out;
    };
    const folderNav = {
      cols: 1,
      focus: (i, opts) => { const f = foldersRef.current[i]; if (f) focusKey(folderKey(f.folder), opts); },
      reveal: (i) => { const f = foldersRef.current[i]; if (f) rowFor(folderKey(f.folder))?.scrollIntoView({ block: 'nearest' }); },
      hits: (rect) => hits(rect, 'data-folder').map(folderKey),
    };
    const fileNav = {
      cols: 1,
      rowsPerPage: Math.max(1, Math.floor((height || 400) / 32) - 1),
      focus: (i, opts) => { const f = filesRef.current[i]; if (f) focusKey(fileKey(f.id), opts); },
      reveal: (i) => { const f = filesRef.current[i]; if (f) rowFor(fileKey(f.id))?.scrollIntoView({ block: 'nearest' }); },
      update: () => {},
    };
    navRef.current.folders = folderNav;
    navRef.current.files = fileNav;
    registered.current = { folderNav, fileNav };
    if (marqueeRef) {
      marqueeRef.current = {
        hitsIn: (rect) => hits(rect, 'data-file-id').map((id) => filesRef.current.findIndex((f) => String(f.id) === id)).filter((i) => i >= 0),
      };
    }
  }
  // Gone with the layout — unless the next one has registered its own
  // already, which it does as it renders, before this runs.
  useEffect(() => () => {
    const { folderNav, fileNav } = registered.current;
    if (navRef?.current?.folders === folderNav) delete navRef.current.folders;
    if (navRef?.current?.files === fileNav) delete navRef.current.files;
  }, [navRef]);

  const onFocus = (e) => {
    const el = e.target?.closest?.('[data-file-id], [data-folder]');
    if (!el) return;
    const key = el.hasAttribute('data-folder') ? folderKey(el.getAttribute('data-folder')) : fileKey(el.getAttribute('data-file-id'));
    const i = order.indexOf(key);
    if (i >= 0) setActive((a) => (a === i ? a : i));
  };

  // → into the selected folder, ← up to the enclosing one; the rest is the
  // selection model's.
  const keyDown = (e, key, isFolder) => {
    if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (e.key === 'ArrowRight') { e.preventDefault(); if (isFolder) onOpenFolder(key.slice(2)); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); if (folder) onGoUp(); return; }
    }
    handlers.keyDown(e, key);
  };

  const drag = handlers?.dragStart;
  const tabbable = order[active] ?? order[0];
  const empty = !shownFolders.length && !files.length;

  return (
    <div className={`colview${pending ? ' is-pending' : ''}`} ref={box} style={height ? { height } : undefined}>
      {ancestors.map((p, idx) => {
        const { files: f, more: m } = filesOf(p);
        return (
          <PathColumn
            key={p || '/'}
            path={p}
            rootName={rootName}
            folders={children.get(p) || []}
            files={f}
            more={m}
            openChild={path[idx + 1]}
            onNavigate={onNavigate}
            onOpenFolder={onOpenFolder}
            onOpenFile={onOpenFile}
            canWrite={canWrite}
            onDrop={onDrop}
            labelFor={labelFor}
            width={width}
          />
        );
      })}
      <div
        className="col is-current"
        ref={current}
        role="listbox"
        aria-label={folder ? baseName(folder) : rootName}
        aria-multiselectable="true"
        aria-busy={pending || undefined}
        onFocus={onFocus}
        style={{ width }}
      >
        {shownFolders.map((f) => {
          const key = folderKey(f.folder);
          const isSel = selectedFolders.has(f.folder);
          return (
            <FolderDrop key={f.folder} target={f.folder} enabled={canWrite} onDrop={onDrop}>
              <div
                role="option"
                aria-selected={isSel}
                tabIndex={key === tabbable ? 0 : -1}
                className={`col-row is-folder${isSel ? ' is-selected' : ''}`}
                data-folder={f.folder}
                title={f.folder}
                onClick={(e) => handlers.click(e, key)}
                onDoubleClick={(e) => handlers.dblclick(e, key)}
                onKeyDown={(e) => keyDown(e, key, true)}
                draggable={canWrite}
                onDragStart={canWrite ? (e) => startFolderDrag(e, f.folder) : undefined}
              >
                <RowIcon />
                <span className="col-name truncate">{f.name}</span>
                <Icon name="chevron-right" size={14} className="col-chevron" />
              </div>
            </FolderDrop>
          );
        })}
        {files.map((f) => {
          const key = fileKey(f.id);
          const isSel = selected.has(f.id);
          return (
            <div
              key={f.id}
              role="option"
              aria-selected={isSel}
              tabIndex={key === tabbable ? 0 : -1}
              className={`col-row${isSel ? ' is-selected' : ''}`}
              data-file-id={f.id}
              title={f.name}
              onClick={(e) => handlers.click(e, key)}
              onDoubleClick={(e) => handlers.dblclick(e, key)}
              onKeyDown={(e) => keyDown(e, key, false)}
              draggable={!!drag}
              onDragStart={drag ? (e) => drag(e, key) : undefined}
            >
              <span className="col-thumb" aria-hidden><Thumb file={f} label={labelFor?.(f)} surface="row" onMissingThumb={onMissingThumb} /></span>
              <span className="col-name truncate">{f.name}</span>
              {badgesFor?.(f)}
            </div>
          );
        })}
        {more && <div ref={sentinel} className="col-note small muted">Loading more…</div>}
        {empty && <p className="col-note small muted">{pending ? 'Loading…' : emptyText}</p>}
      </div>
      {onlyFolder != null && (() => {
        const { files: f, more: m } = filesOf(onlyFolder);
        return (
          <PathColumn
            key={`preview:${onlyFolder}`}
            path={onlyFolder}
            rootName={rootName}
            folders={children.get(onlyFolder) || []}
            files={f}
            more={m}
            openChild={null}
            onNavigate={onNavigate}
            onOpenFolder={onOpenFolder}
            onOpenFile={onOpenFile}
            canWrite={canWrite}
            onDrop={onDrop}
            labelFor={labelFor}
            width={width}
          />
        );
      })()}
      {onlyFile && <Details file={onlyFile} fields={fields} rootName={rootName} labelFor={labelFor} onOpenFile={onOpenFile} width={width} />}
    </div>
  );
}

export default memo(ColumnView);
