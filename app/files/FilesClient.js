'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { buildFacets, fileMatchesFacets, hasAnyFacet, deriveAuto, expiryState } from '@/lib/dam';
import { createThumbnailBackfill } from '@/lib/thumbnail-client';
import { createUploadQueue, uploadOne, filesFromDrop, filesFromInput, joinFolder } from '@/lib/upload-client';
import FileGrid from '@/app/components/ui/FileGrid';
import UploadPanel from '@/app/components/ui/UploadPanel';
import { useToast } from '@/app/components/ui/Toast';
import { useConfirm } from '@/app/components/ui/Confirm';

const KINDS = [
  { key: 'image', label: 'Images' },
  { key: 'video', label: 'Video' },
  { key: 'audio', label: 'Audio' },
  { key: 'doc', label: 'Documents' },
  { key: 'other', label: 'Other' },
];

// Keys must stay in step with SORTS in lib/file-query.js — an unknown key
// falls back to `new` on the server, which reads as "sorting is broken"
// rather than as a typo.
const SORTS = [
  { key: 'new', label: 'Newest' },
  { key: 'old', label: 'Oldest' },
  { key: 'name', label: 'Name' },
  { key: 'size', label: 'Largest' },
];


export default function FilesClient({ flags, canWrite, schema, filespaceId, filespaces }) {
  const [files, setFiles] = useState([]);
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState(null);
  const [error, setError] = useState(null);

  const [folder, setFolder] = useState('');
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState([]);
  const [sort, setSort] = useState('new');
  const [facets, setFacets] = useState({});
  const [selected, setSelected] = useState(new Set());
  const [uploadSnap, setUploadSnap] = useState(null);
  const [dragging, setDragging] = useState(false);
  // Phone only: facets live behind a toggle. On desktop the sidebar is always
  // there and this is ignored by the stylesheet.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const router = useRouter();
  const toast = useToast();
  const { confirm, confirmElement } = useConfirm();

  const inputRef = useRef(null);
  const folderInputRef = useRef(null);
  const dragDepth = useRef(0);
  const sentinelRef = useRef(null);
  // Guards against a stale response from a superseded filter overwriting the
  // results of a newer one — without this, fast typing can leave the grid
  // showing the results of a query the user has already moved past.
  const requestRef = useRef(0);

  /**
   * Fetch one page. `after` is the opaque cursor from the previous page; with
   * no cursor this is a fresh query and replaces the grid rather than
   * appending to it. `quiet` keeps the grid up while it refetches, for the
   * refreshes an upload batch triggers as files land.
   */
  const fetchPage = useCallback(async (after = null, quiet = false) => {
    const token = ++requestRef.current;
    if (after) setLoadingMore(true);
    else if (!quiet) setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams();
      if (folder) p.set('folder', folder);
      if (query) p.set('q', query);
      if (kinds.length) p.set('kind', kinds.join(','));
      p.set('sort', sort);
      if (filespaceId) p.set('filespace', filespaceId);
      if (after) p.set('cursor', after);
      p.set('folders', '0');
      const r = await fetch(`/api/files?${p}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Request failed (${r.status})`);
      const data = await r.json();
      if (token !== requestRef.current) return; // superseded
      setFiles((prev) => (after ? [...prev, ...(data.files || [])] : data.files || []));
      setCursor(data.cursor || null);
    } catch (e) {
      if (token === requestRef.current) setError(e.message);
    } finally {
      if (token === requestRef.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [folder, query, kinds, sort, filespaceId]);

  const load = useCallback(() => fetchPage(null), [fetchPage]);
  const refresh = useCallback(() => fetchPage(null, true), [fetchPage]);

  // The folder tree, loaded once per filespace and again only after an upload
  // or a removal changes what is in a folder. It used to ride along with every
  // first page, so each filter change and search keystroke re-counted the
  // whole library and downloaded a couple of hundred kilobytes of tree.
  const loadFolders = useCallback(async () => {
    try {
      const r = await fetch(`/api/files/folders${filespaceId ? `?filespace=${encodeURIComponent(filespaceId)}` : ''}`);
      if (!r.ok) return;
      const data = await r.json();
      setFolders(data.folders || []);
    } catch {}
  }, [filespaceId]);

  useEffect(() => { loadFolders(); }, [loadFolders]);

  // Drop the selection whenever the result set changes underneath it.
  // Without this, switching folders with 40 files selected left "Trash 40"
  // acting on rows that were no longer on screen.
  useEffect(() => { setSelected(new Set()); }, [folder, query, kinds, filespaceId]);

  // Debounce so typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(load, query ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  // Infinite scroll. Observing a sentinel below the grid costs nothing while
  // it is off screen, and at 100k files a "load more" button would be a lot of
  // clicking. Re-created whenever the cursor changes so it always requests the
  // page after the one currently held.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !cursor || loading || loadingMore) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) fetchPage(cursor);
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loading, loadingMore, fetchPage]);

  // Facet counts come from the loaded rows, so they always describe what is
  // actually on screen rather than the whole bucket.
  const facetDefs = useMemo(() => buildFacets(files, schema), [files, schema]);
  const visible = useMemo(
    () => (hasAnyFacet(facets) ? files.filter((f) => fileMatchesFacets(f, facets, schema)) : files),
    [files, facets, schema]
  );

  const toggleFacet = (key, value) => {
    setFacets((prev) => {
      const cur = new Set(prev[key] || []);
      cur.has(value) ? cur.delete(value) : cur.add(value);
      const next = { ...prev };
      cur.size ? (next[key] = [...cur]) : delete next[key];
      return next;
    });
  };

  // The cursor is keyed to the sort column — it is the last row's value of
  // that column plus its id — so a cursor taken under one ordering selects a
  // meaningless slice under another. Dropping it here also unmounts the
  // infinite-scroll sentinel, which otherwise had a window to request the
  // next page of the OLD ordering before the refetch replaced the grid.
  const changeSort = (next) => { setSort(next); setCursor(null); };

  const toggleKind = (k) =>
    setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  // ── Upload ────────────────────────────────────────────────────────────────
  // A queue, a few files at a time (lib/upload-client.js). Each file goes
  // straight to the bucket with a presigned PUT or a multipart upload, then is
  // recorded; the grid refreshes as files land and once more when the queue
  // is empty, along with the folder tree a folder upload may have grown.
  const live = useRef({});
  live.current = { filespaceId, refresh, loadFolders, toast };
  const settled = useRef({ done: 0, error: 0 });
  const refreshTimer = useRef(null);
  const [queue] = useState(() => createUploadQueue({
    run: async (item, opts) => {
      const row = await uploadOne(item.file, {
        folder: item.folder,
        filespaceId: live.current.filespaceId,
        resumeId: item.resumeId,
        ...opts,
      });
      // New tiles appear while the rest of the batch is still going, a
      // refresh every second or so rather than one per file.
      refreshTimer.current ||= setTimeout(() => { refreshTimer.current = null; live.current.refresh(); }, 1200);
      return row;
    },
    onChange: setUploadSnap,
    onSettled: (snap) => {
      const { refresh: reload, loadFolders: reloadFolders, toast: t } = live.current;
      // Counts since the last time the queue went quiet; a retry that fails
      // again moves nothing.
      const done = Math.max(0, snap.counts.done - settled.current.done);
      const failed = Math.max(0, snap.counts.error - settled.current.error);
      settled.current = { done: snap.counts.done, error: snap.counts.error };
      if (!done && !failed) return;
      clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
      reload();
      reloadFolders();
      if (failed > 0) {
        const first = snap.items.find((i) => i.status === 'error')?.error;
        t.error(failed === 1 && !done ? first : `${failed} of ${done + failed} uploads failed. ${first}`);
      } else {
        t.success(`${done} file${done === 1 ? '' : 's'} uploaded.`);
      }
    },
  }));

  // Leaving mid-upload loses the rest of the queue; say so.
  useEffect(() => {
    if (!uploadSnap?.running) return;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [uploadSnap?.running]);

  // `entries` are [{ file, dir }]; `dir` is relative to the current folder, so
  // a dropped folder keeps its structure beneath wherever it was dropped.
  const enqueue = useCallback((entries) => {
    if (!entries.length) return;
    queue.add(entries.map(({ file, dir }) => ({ file, folder: joinFolder(folder, dir) })));
  }, [queue, folder]);

  const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

  const onDragEnter = (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragLeave = (e) => {
    if (!isFileDrag(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragging(false);
  };

  const onDrop = (e) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!e.dataTransfer?.files?.length) return;
    if (!canWrite) { toast.error('Your role can view files here but not upload them.'); return; }
    // Taken synchronously: the DataTransfer is emptied once this returns.
    filesFromDrop(e.dataTransfer).then(enqueue, (err) => toast.error(`Could not read the dropped files: ${err.message}`));
  };

  const trashSelected = async () => {
    if (!selected.size) return;
    const n = selected.size;
    const ok = await confirm({
      title: flags.trash
        ? `Remove ${n} file${n === 1 ? '' : 's'} from the library?`
        : `Permanently delete ${n} file${n === 1 ? '' : 's'}?`,
      body: flags.trash
        ? 'The row is hidden and the object is kept, so an admin can restore it from the database. There is no trash screen.'
        : 'This cannot be undone.',
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    // The server decides trash-vs-purge from its own flag state.
    const results = await Promise.all([...selected].map((id) => fetch(`/api/files/${id}`, { method: 'DELETE' })));
    const failed = results.filter((r) => !r.ok).length;
    setSelected(new Set());
    load();
    loadFolders();
    if (failed) toast.error(`${failed} of ${n} could not be removed.`);
    else toast.success(`${n} file${n === 1 ? '' : 's'} removed.`);
  };

  // Files from before thumbnails were made at upload get one when their tile
  // is seen by someone who may edit them. See lib/thumbnail-client.js.
  const requestThumb = useMemo(() => (canWrite
    ? createThumbnailBackfill((f) => setFiles((prev) => prev.map((x) => (x.id === f.id
      ? { ...x, thumbnailUrl: f.thumbnailUrl, thumbnailKey: f.thumbnailKey, metadata: f.metadata }
      : x))))
    : null), [canWrite]);

  const openFile = useCallback((f) => { if (f?.id) router.push(`/files/${f.id}`); }, [router]);

  const toggleSelect = useCallback((f) => {
    setSelected((s) => {
      const n = new Set(s);
      n.has(f.id) ? n.delete(f.id) : n.add(f.id);
      return n;
    });
  }, []);

  // The bottom padding travels as a custom property because the inline
  // shorthand below outranks any stylesheet rule: the phone selection bar is
  // fixed, so the page has to reserve room for it, and only the stylesheet
  // knows whether the bar is on screen.
  return (
    <main
      className={`shell files-main${selected.size ? ' is-selecting' : ''}`}
      style={{ padding: '24px 24px var(--files-pad-b, 64px)' }}
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="row" style={{ marginBottom: 20 }}>
        <h1 className="files-title" style={{ fontSize: 24, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{folder || 'All files'}</h1>
        <span className="muted small">
          {visible.length}{visible.length !== files.length ? ` of ${files.length}` : ''}{cursor ? '+' : ''}
        </span>
        <div className="spacer" />
        {selected.size > 0 && (
          <button className="btn btn-danger" onClick={trashSelected}>
            Remove {selected.size}
          </button>
        )}
        {canWrite && (
          <>
            <input
              ref={inputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => { enqueue(filesFromInput(e.target.files)); e.target.value = ''; }}
            />
            <input
              ref={folderInputRef}
              type="file"
              webkitdirectory=""
              hidden
              onChange={(e) => { enqueue(filesFromInput(e.target.files)); e.target.value = ''; }}
            />
            <button className="btn" onClick={() => folderInputRef.current?.click()}>Upload folder</button>
            <button className="btn btn-primary" onClick={() => inputRef.current?.click()}>Upload</button>
          </>
        )}
      </div>

      <div className="files-toolbar">
        <input
          className="input"
          type="search"
          placeholder="Search files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="input"
          style={{ width: 'auto' }}
          aria-label="Sort by"
          value={sort}
          onChange={(e) => changeSort(e.target.value)}
        >
          {SORTS.map((o) => (
            <option key={o.key} value={o.key}>{o.label}</option>
          ))}
        </select>
        <div className="kind-row">
        <div className="kind-strip edge-scroll">
          {KINDS.map((k) => (
            <button
              key={k.key}
              className="btn"
              onClick={() => toggleKind(k.key)}
              style={kinds.includes(k.key) ? { background: 'var(--ink)', color: 'var(--paper)', borderColor: 'var(--ink)' } : undefined}
            >
              {k.label}
            </button>
          ))}
        </div>
        {flags.metadata && facetDefs.some((d) => d.values.length > 0) && (
          <button
            className="btn only-mobile"
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
            style={hasAnyFacet(facets) || filtersOpen ? { borderColor: 'var(--ink)' } : undefined}
          >
            Filters{hasAnyFacet(facets) ? ` · ${Object.values(facets).reduce((n, v) => n + v.length, 0)}` : ''}
          </button>
        )}
        </div>
      </div>

      {error && (
        <div className="card" style={{ padding: 16, marginBottom: 16, borderColor: 'var(--danger)' }}>
          <p className="small" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p>
        </div>
      )}

      <div className="files-layout">
          <aside>
            <div className="side-folders">
              <Section title="Folders">
                <div className="folder-list edge-scroll">
                  <FolderLink active={!folder} onClick={() => setFolder('')}>All files</FolderLink>
                  <FolderTree folders={folders} selected={folder} onSelect={setFolder} />
                </div>
              </Section>
            </div>

            <div className={`side-facets${filtersOpen ? ' open' : ''}`}>
            {flags.metadata &&
              facetDefs
                .filter((d) => d.values.length > 0)
                .map((d) => (
                  <Section key={d.key} title={d.label}>
                    {d.values.slice(0, 8).map((v) => (
                      <label key={v.value} className="row small" style={{ gap: 6, padding: '3px 0', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={(facets[d.key] || []).includes(v.value)}
                          onChange={() => toggleFacet(d.key, v.value)}
                        />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.value}</span>
                        <div className="spacer" />
                        <span className="muted">{v.count}</span>
                      </label>
                    ))}
                  </Section>
                ))}
            </div>
          </aside>

          <section>
            {loading ? (
              <div className="empty">Loading…</div>
            ) : (
              <FileGrid
                files={visible}
                selected={selected}
                onSelect={toggleSelect}
                onOpen={openFile}
                onMissingThumb={requestThumb}
                labelFor={(f) => deriveAuto(f).format || f.kind}
                badgesFor={(f) => {
                  const e = flags.usageRights ? expiryState(f, schema) : null;
                  if (e === 'expired') return <span className="tag tag-danger">Expired</span>;
                  if (e === 'soon') return <span className="tag tag-warning">Expiring</span>;
                  return null;
                }}
                emptyState={(
                  <div className="empty">
                    {files.length === 0
                      ? canWrite ? 'Nothing here yet. Drop files anywhere on this page to upload.' : 'Nothing here yet.'
                      : 'No files match those filters.'}
                  </div>
                )}
              />
            )}
            {/* Sentinel for infinite scroll. Rendered only while a next page
                exists, so reaching the end is what stops the observer. */}
            {cursor && <div ref={sentinelRef} style={{ height: 1 }} />}
            {loadingMore && <div className="empty" style={{ padding: 24 }}>Loading more…</div>}
          </section>
      </div>
      {/* Phone only, and shown by the stylesheet rather than a viewport check
          in JS: the header's Trash button scrolls away, leaving a selection
          with nothing to act on. Rendered whenever something is selected —
          .files-selbar is display:none above the phone breakpoint, so a JS
          check here could only disagree with the CSS during hydration. */}
      {selected.size > 0 && (
        <div className="files-selbar" role="toolbar" aria-label="Selected files">
          <span className="small">{selected.size} selected</span>
          <div className="spacer" />
          <button className="btn" onClick={() => setSelected(new Set())}>Clear</button>
          <button className="btn btn-danger" onClick={trashSelected}>
            Remove
          </button>
        </div>
      )}
      <UploadPanel
        snapshot={uploadSnap}
        onCancel={queue.cancel}
        onRetry={queue.retry}
        onRetryFailed={() => uploadSnap?.items.filter((i) => i.status === 'error').forEach((i) => queue.retry(i.id))}
        onClear={() => { queue.clear(); settled.current = { done: 0, error: 0 }; }}
      />
      {dragging && canWrite && (
        <div className="drop-overlay" aria-hidden>
          <div className="stack" style={{ textAlign: 'center', gap: 'var(--s1)' }}>
            <strong>Drop to upload</strong>
            <span className="small muted">Files and folders go into {folder || 'All files'}</span>
          </div>
        </div>
      )}
      {confirmElement}
    </main>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h3 className="small muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 11, marginBottom: 6 }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

function FolderLink({ active, onClick, children }) {
  return (
    <button onClick={onClick} className={`small folder-link${active ? ' active' : ''}`}>
      {children}
    </button>
  );
}

/**
 * The sidebar's folders as a tree. The API sends every folder path, ancestors
 * included, with its parent. Top-level folders show; a folder's children show
 * once it is opened. Selecting a folder opens it and everything above it, so
 * the row just chosen is on screen rather than inside a collapsed branch.
 */
function FolderTree({ folders, selected, onSelect }) {
  const [open, setOpen] = useState(() => new Set());

  const children = useMemo(() => {
    const paths = new Set(folders.map((f) => f.folder));
    const byParent = new Map();
    for (const f of folders) {
      // A folder shared on its own arrives without its parent. Show it at the
      // top level rather than under a branch that never renders.
      const parent = paths.has(f.parent) ? f.parent : '';
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(f);
    }
    return byParent;
  }, [folders]);

  useEffect(() => {
    if (!selected) return;
    setOpen((prev) => {
      const next = new Set(prev);
      for (let p = selected; p; p = p.slice(0, Math.max(p.lastIndexOf('/'), 0))) next.add(p);
      return next;
    });
  }, [selected]);

  const toggle = (path) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  const rows = [];
  const walk = (parent, depth) => {
    for (const f of children.get(parent) || []) {
      rows.push({ f, depth });
      if (open.has(f.folder)) walk(f.folder, depth + 1);
    }
  };
  walk('', 0);

  return rows.map(({ f, depth }) => {
    const isOpen = open.has(f.folder);
    return (
      <div key={f.folder} className="folder-row" style={{ '--depth': depth }}>
        {children.has(f.folder) ? (
          <button
            className="folder-toggle"
            onClick={() => toggle(f.folder)}
            aria-expanded={isOpen}
            aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${f.folder}`}
          >
            <span aria-hidden>{isOpen ? '▾' : '▸'}</span>
          </button>
        ) : (
          <span className="folder-toggle" aria-hidden />
        )}
        <FolderLink active={selected === f.folder} onClick={() => onSelect(f.folder)}>
          {f.name} {f.count != null && <span className="muted">{f.count}</span>}
        </FolderLink>
      </div>
    );
  });
}
