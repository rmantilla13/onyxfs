'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import FilespaceSwitcher from '@/app/components/FilespaceSwitcher';
import { buildFacets, fileMatchesFacets, hasAnyFacet, deriveAuto, expiryState } from '@/lib/dam';
import { createThumbnailBackfill } from '@/lib/thumbnail-client';
import { createUploadQueue, uploadOne, filesFromDrop, filesFromInput, joinFolder } from '@/lib/upload-client';
import FileGrid from '@/app/components/ui/FileGrid';
import FileList, { FileListHeader } from '@/app/components/ui/FileList';
import { VIEW_STORAGE_KEY, parseView } from '@/lib/list-columns';
import UploadPanel from '@/app/components/ui/UploadPanel';
import { useToast } from '@/app/components/ui/Toast';
import { useConfirm } from '@/app/components/ui/Confirm';
import { usePrompt } from '@/app/components/ui/Prompt';
import { useFolderPicker } from '@/app/components/ui/FolderPicker';
import Menu, { MenuItem, MenuSeparator } from '@/app/components/ui/Menu';
import { useContextMenu } from '@/app/components/ui/ContextMenu';
import { folderNameProblem, fileNameProblem, parentOf, baseName, isWithin, rebase, mapLimit } from '@/lib/folder-ops';

const KINDS = [
  { key: 'image', label: 'Images' },
  { key: 'video', label: 'Video' },
  { key: 'audio', label: 'Audio' },
  { key: 'doc', label: 'Documents' },
  { key: 'other', label: 'Other' },
];

// Drag payloads for moves inside the library. An OS file drag carries
// 'Files' instead, which is what tells an upload from a move.
const DRAG_FILES = 'application/x-onyx-files';
const DRAG_FOLDER = 'application/x-onyx-folder';

// Keys must stay in step with SORTS in lib/file-query.js — an unknown key
// falls back to `new` on the server, which reads as "sorting is broken"
// rather than as a typo. The list view's column headers pick from the same
// keys (lib/list-columns.js).
const SORTS = [
  { key: 'new', label: 'Newest' },
  { key: 'old', label: 'Oldest' },
  { key: 'modified', label: 'Recently modified' },
  { key: 'modified_old', label: 'Least recently modified' },
  { key: 'name', label: 'Name A–Z' },
  { key: 'name_desc', label: 'Name Z–A' },
  { key: 'size', label: 'Largest' },
  { key: 'small', label: 'Smallest' },
  { key: 'type', label: 'Type A–Z' },
  { key: 'type_desc', label: 'Type Z–A' },
];


export default function FilesClient({ flags, canWrite, schema, filespaceId, filespaces, isAdmin = false }) {
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
  // Grid or list. Starts as grid on the server and in the first client
  // render, then takes the stored choice after mount — reading localStorage
  // during render would disagree with the server HTML and fail hydration.
  const [view, setView] = useState('grid');
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
  const { prompt, promptElement } = usePrompt();
  const { pick, pickerElement } = useFolderPicker();
  const { openMenu, contextMenuElement } = useContextMenu();

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

  useEffect(() => {
    try { setView(parseView(localStorage.getItem(VIEW_STORAGE_KEY))); } catch {}
  }, []);
  const changeView = (next) => {
    setView(next);
    try { localStorage.setItem(VIEW_STORAGE_KEY, next); } catch {}
  };

  // A soft navigation: the page re-renders with the new ?filespace= and the
  // effects above refetch. The open folder belongs to the old filespace.
  const switchFilespace = useCallback((id) => {
    if ((id || '') === (filespaceId || '')) return;
    setFolder('');
    router.push(id ? `/files?filespace=${encodeURIComponent(id)}` : '/files');
  }, [filespaceId, router]);

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

  // The open folder's own subfolders, shown as tiles above its files so a
  // folder can be opened, dropped on and right-clicked from the main pane,
  // not only from the tree. Hidden while searching or filtering: results are
  // a flat list across folders.
  const showTiles = !query && !kinds.length && !hasAnyFacet(facets);
  const subfolders = useMemo(() => {
    const paths = new Set(folders.map((f) => f.folder));
    return folders.filter((f) => (paths.has(f.parent) ? f.parent : '') === folder);
  }, [folders, folder]);

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
  // Entries without a file are the empty directories of a dropped tree; they
  // become empty folders rather than vanishing.
  const enqueue = useCallback((entries, base = folder) => {
    const withFiles = entries.filter((e) => e.file);
    const empty = entries.filter((e) => !e.file);
    if (withFiles.length) queue.add(withFiles.map(({ file, dir }) => ({ file, folder: joinFolder(base, dir) })));
    if (empty.length) {
      (async () => {
        for (const { dir } of empty) {
          await fetch('/api/files/folders', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: joinFolder(base, dir), filespaceId: filespaceId || undefined, ensure: true }),
          }).catch(() => {});
        }
        loadFolders();
      })();
    }
  }, [queue, folder, filespaceId, loadFolders]);

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

  const trashSelected = () => removeFiles([...selected]);

  // Remove files by id: the selection, or one file from its context menu.
  const removeFiles = async (ids) => {
    if (!ids.length) return;
    const n = ids.length;
    const one = n === 1 ? files.find((f) => f.id === ids[0]) : null;
    const ok = await confirm({
      title: flags.trash
        ? `Remove ${one ? `“${one.name}”` : `${n} files`} from the library?`
        : `Permanently delete ${one ? `“${one.name}”` : `${n} files`}?`,
      body: flags.trash
        ? 'The row is hidden and the object is kept, so an admin can restore it from the database. There is no trash screen.'
        : 'This cannot be undone.',
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    // The server decides trash-vs-purge from its own flag state.
    const results = await Promise.all(ids.map((id) => fetch(`/api/files/${id}`, { method: 'DELETE' })));
    const failed = results.filter((r) => !r.ok).length;
    setSelected((s) => { const next = new Set(s); ids.forEach((id) => next.delete(id)); return next; });
    load();
    loadFolders();
    if (failed) toast.error(`${failed} of ${n} could not be removed.`);
    else toast.success(`${n} file${n === 1 ? '' : 's'} removed.`);
  };

  // ── Folders ───────────────────────────────────────────────────────────────
  // Create, rename, move and delete go through /api/files/folders, which
  // moves the stored objects too (keys encode the folder) and either does all
  // of a rename or none of it. Dialogs are in-app: usePrompt, useConfirm and
  // the folder picker.
  const fsBody = filespaceId || undefined;
  const fsQuery = filespaceId ? `&filespace=${encodeURIComponent(filespaceId)}` : '';

  const newFolder = async (parent = folder) => {
    const created = await prompt({
      title: 'New folder',
      label: parent ? `Name (inside ${parent})` : 'Name',
      placeholder: 'Untitled folder',
      confirmLabel: 'Create',
      validate: folderNameProblem,
      submit: async (name) => {
        const r = await fetch('/api/files/folders', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: joinFolder(parent, name), filespaceId: fsBody }),
        });
        return r.ok ? null : (await r.json().catch(() => ({}))).error || `Could not create the folder (HTTP ${r.status}).`;
      },
    });
    if (created == null) return;
    await loadFolders();
    setFolder(joinFolder(parent, created));
    toast.success(`Folder “${created}” created.`);
  };

  // After a folder moves, anything that pointed into it follows.
  const followFolder = (from, to) => {
    if (isWithin(folder, from)) setFolder(rebase(folder, from, to));
    load();
    loadFolders();
  };

  const describeRename = (res) => {
    const notes = [];
    if (res.outside) notes.push(`${res.outside} file${res.outside === 1 ? '' : 's'} from another filespace stayed at the old path.`);
    if (res.leftovers) notes.push(`${res.leftovers} old cop${res.leftovers === 1 ? 'y' : 'ies'} could not be removed from storage.`);
    return notes.join(' ');
  };

  const renameFolderUI = async (path) => {
    let result = null;
    const name = await prompt({
      title: 'Rename folder',
      label: 'Name',
      value: baseName(path),
      confirmLabel: 'Rename',
      validate: folderNameProblem,
      submit: async (next) => {
        if (next === baseName(path)) return null;
        const r = await fetch('/api/files/folders', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ from: path, to: joinFolder(parentOf(path), next), filespaceId: fsBody }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) return body.error || `Could not rename the folder (HTTP ${r.status}).`;
        result = body;
        return null;
      },
    });
    if (name == null || !result) return;
    followFolder(path, result.to);
    const note = describeRename(result);
    note ? toast.error(`Renamed to “${name}”. ${note}`) : toast.success(`Renamed to “${name}”.`);
  };

  const moveFolderTo = async (path, dest) => {
    const to = joinFolder(dest, baseName(path));
    if (to === path || isWithin(dest, path)) return;
    const r = await fetch('/api/files/folders', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: path, to, filespaceId: fsBody }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { toast.error(body.error || `Could not move the folder (HTTP ${r.status}).`); return; }
    followFolder(path, to);
    const note = describeRename(body);
    const where = dest || 'All files';
    note ? toast.error(`Moved “${baseName(path)}” to ${where}. ${note}`) : toast.success(`Moved “${baseName(path)}” to ${where}.`);
  };

  const moveFolderUI = async (path) => {
    const dest = await pick({ title: `Move “${baseName(path)}”`, folders, exclude: path, current: parentOf(path) });
    if (dest != null) await moveFolderTo(path, dest);
  };

  const deleteFolderUI = async (path) => {
    const r = await fetch(`/api/files/folders?summary=${encodeURIComponent(path)}${fsQuery}`);
    const sum = await r.json().catch(() => ({}));
    if (!r.ok) { toast.error(sum.error || `Could not read the folder (HTTP ${r.status}).`); return; }
    const parts = [];
    if (sum.files) parts.push(`${sum.files} file${sum.files === 1 ? '' : 's'}`);
    if (sum.folders) parts.push(`${sum.folders} subfolder${sum.folders === 1 ? '' : 's'}`);
    const inside = parts.length ? parts.join(' and ') : null;
    const ok = await confirm({
      title: `Delete “${baseName(path)}”?`,
      body: [
        inside
          ? (flags.trash
            ? `It holds ${inside}. They are removed from the library; the stored files are moved aside, not destroyed, so an admin can restore them from the database.`
            : `It holds ${inside}, which will be permanently deleted. This cannot be undone.`)
          : 'The folder is empty.',
        sum.outside ? `${sum.outside} file${sum.outside === 1 ? '' : 's'} from another filespace at this path will stay.` : '',
      ].filter(Boolean).join(' '),
      confirmLabel: 'Delete folder',
    });
    if (!ok) return;
    let deleted = 0;
    let failed = 0;
    let lastError = null;
    // The server trashes a batch per call and says whether there is more.
    for (let round = 0; round < 1000; round++) {
      const d = await fetch(`/api/files/folders?name=${encodeURIComponent(path)}${fsQuery}`, { method: 'DELETE' });
      const body = await d.json().catch(() => ({}));
      if (!d.ok) { lastError = body.error || `HTTP ${d.status}`; break; }
      deleted += body.deleted || 0;
      failed = body.failed || 0;
      lastError = body.error;
      if (!body.more || !body.deleted) break;
    }
    if (isWithin(folder, path) && !failed && !lastError) setFolder(parentOf(path));
    load();
    loadFolders();
    if (failed || (lastError && !deleted)) toast.error(`${failed ? `${failed} file${failed === 1 ? '' : 's'} could not be removed, so the folder stays.` : ''} ${lastError || ''}`.trim());
    else toast.success(`Deleted “${baseName(path)}”${deleted ? ` and ${deleted} file${deleted === 1 ? '' : 's'}` : ''}.`);
  };

  // Move files one request each, a few at a time: PATCH /api/files/[id]
  // moves the object and the row together and refuses to do half.
  const moveFiles = async (ids, dest) => {
    const list = ids.filter((id) => files.find((f) => f.id === id)?.folder !== dest);
    if (!list.length) return;
    let failed = 0;
    let catalogOnly = 0;
    let firstError = null;
    await mapLimit(list, 4, async (id) => {
      const r = await fetch(`/api/files/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folder: dest, filespaceId: fsBody }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { failed++; firstError ||= body.error || `HTTP ${r.status}`; }
      else if (body.objectMoved === false) catalogOnly++;
    });
    setSelected(new Set());
    load();
    loadFolders();
    const n = list.length - failed;
    const where = dest || 'All files';
    if (failed) toast.error(`${failed} of ${list.length} could not be moved. ${firstError}`);
    else if (catalogOnly) toast.error(`Moved ${n} to ${where}, but ${catalogOnly} stored file${catalogOnly === 1 ? '' : 's'} could not be moved from here: open its filespace to move it.`);
    else toast.success(`Moved ${n} file${n === 1 ? '' : 's'} to ${where}.`);
  };

  const moveSelectedUI = () => moveFilesUI([...selected]);

  const moveFilesUI = async (ids) => {
    const n = ids.length;
    if (!n) return;
    const one = n === 1 ? files.find((f) => f.id === ids[0]) : null;
    const dest = await pick({ title: one ? `Move “${one.name}”` : `Move ${n} files`, folders, current: one ? one.folder || '' : folder || '' });
    if (dest != null) await moveFiles(ids, dest);
  };

  // Renames the stored object too when it can (PATCH moves the key), so a
  // mounted drive shows the same name as the web.
  const renameFileUI = async (f) => {
    let saved = null;
    const name = await prompt({
      title: 'Rename file',
      label: 'Name',
      value: f.name,
      selectStem: true,
      confirmLabel: 'Rename',
      validate: fileNameProblem,
      submit: async (next) => {
        if (next === f.name) return null;
        const r = await fetch(`/api/files/${f.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: next, filespaceId: fsBody }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) return body.error === 'No access' ? 'You can view this file but not rename it.' : body.error || `Could not rename the file (HTTP ${r.status}).`;
        saved = body;
        return null;
      },
    });
    if (name == null || !saved) return;
    // Keep the signed URLs the grid already has; the PATCH row is unsigned.
    setFiles((prev) => prev.map((x) => (x.id === f.id ? { ...x, name: saved.file?.name || name, storageKey: saved.file?.storageKey ?? x.storageKey } : x)));
    if (saved.objectMoved === false) toast.error(`Renamed to “${name}” here; the stored file keeps its old name. Open its filespace to rename it there too.`);
    else toast.success(`Renamed to “${name}”.`);
  };

  // Same-origin, so the route's redirect to a signed attachment URL saves the
  // file instead of opening it.
  const downloadFile = (f) => {
    const a = document.createElement('a');
    a.href = `/api/files/${f.id}/download`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // A card drag carries the whole selection when the card is part of it.
  const onDragFile = useCallback((f, e) => {
    const ids = selected.has(f.id) ? [...selected] : [f.id];
    e.dataTransfer.setData(DRAG_FILES, JSON.stringify(ids));
    e.dataTransfer.setData('text/plain', ids.length === 1 ? f.name : `${ids.length} files`);
    e.dataTransfer.effectAllowed = 'move';
  }, [selected]);

  // Something dropped on a folder in the tree: files or a folder from inside
  // the library move there; files from the desktop upload into it.
  const onTreeDrop = (target, e) => {
    const dt = e.dataTransfer;
    const types = [...(dt?.types || [])];
    if (types.includes(DRAG_FILES)) {
      let ids = [];
      try { ids = JSON.parse(dt.getData(DRAG_FILES)); } catch {}
      if (ids.length) moveFiles(ids, target);
    } else if (types.includes(DRAG_FOLDER)) {
      const path = dt.getData(DRAG_FOLDER);
      if (path) moveFolderTo(path, target);
    } else if (types.includes('Files') && dt.files?.length) {
      filesFromDrop(dt).then((entries) => enqueue(entries, target), (err) => toast.error(`Could not read the dropped files: ${err.message}`));
    }
  };

  // ── Context menus ─────────────────────────────────────────────────────────
  // One handler for the whole page: the target is found from data attributes
  // (data-file-id on a card, data-folder on a folder), so the grid, the
  // folder tiles and the tree need no menu plumbing of their own. Inputs and
  // links keep the browser's menu, as does anything outside the file area.
  const selectAll = () => setSelected(new Set(visible.map((f) => f.id)));

  const fileMenu = (f) => {
    const many = selected.has(f.id) && selected.size > 1 ? [...selected] : null;
    if (many) {
      return [
        { heading: `${many.length} files selected` },
        canWrite && { label: `Move ${many.length} files…`, onSelect: () => moveFilesUI(many) },
        { label: 'Clear selection', onSelect: () => setSelected(new Set()) },
        canWrite && '-',
        canWrite && { label: `Delete ${many.length} files…`, danger: true, onSelect: () => removeFiles(many) },
      ];
    }
    return [
      { heading: f.name },
      { label: 'Open', hint: 'Enter', onSelect: () => openFile(f) },
      { label: 'Download', onSelect: () => downloadFile(f) },
      canWrite && '-',
      canWrite && { label: 'Rename…', onSelect: () => renameFileUI(f) },
      canWrite && { label: 'Move…', onSelect: () => moveFilesUI([f.id]) },
      { label: selected.has(f.id) ? 'Deselect' : 'Select', hint: 'Space', onSelect: () => toggleSelect(f) },
      canWrite && '-',
      canWrite && { label: 'Delete…', danger: true, onSelect: () => removeFiles([f.id]) },
    ];
  };

  const folderMenu = (path) => [
    { heading: baseName(path) },
    { label: 'Open', onSelect: () => setFolder(path) },
    canWrite && '-',
    canWrite && { label: 'New folder inside…', onSelect: () => newFolder(path) },
    canWrite && { label: 'Rename…', onSelect: () => renameFolderUI(path) },
    canWrite && { label: 'Move…', onSelect: () => moveFolderUI(path) },
    canWrite && '-',
    canWrite && { label: 'Delete folder…', danger: true, onSelect: () => deleteFolderUI(path) },
  ];

  const blankMenu = (at = folder) => [
    { heading: at || 'All files' },
    canWrite && { label: 'New folder…', onSelect: () => newFolder(at) },
    canWrite && { label: 'Upload files…', onSelect: () => inputRef.current?.click() },
    canWrite && { label: 'Upload folder…', onSelect: () => folderInputRef.current?.click() },
    canWrite && '-',
    { label: 'Select all', disabled: !visible.length, onSelect: selectAll },
    selected.size > 0 && { label: 'Clear selection', onSelect: () => setSelected(new Set()) },
    { label: 'Refresh', onSelect: () => { load(); loadFolders(); } },
  ];

  const menuFor = (target) => {
    if (target?.closest?.('input, textarea, select, [contenteditable], a[href], .files-toolbar, .ctx-menu, dialog')) return null;
    const card = target?.closest?.('[data-file-id]');
    if (card) {
      const f = files.find((x) => x.id === card.dataset.fileId);
      return f ? { el: card, items: fileMenu(f) } : null;
    }
    const dir = target?.closest?.('[data-folder]');
    if (dir) {
      const path = dir.dataset.folder;
      return { el: dir, items: path ? folderMenu(path) : blankMenu('') };
    }
    const pane = target?.closest?.('.files-pane');
    return pane ? { el: pane, items: blankMenu() } : null;
  };

  // The menu key and Shift+F10 also fire a contextmenu event in most
  // browsers; opening from keydown and ignoring the echo keeps it to one.
  const keyOpened = useRef(0);
  const onContextMenu = (e) => {
    if (Date.now() - keyOpened.current < 400) { e.preventDefault(); return; }
    const m = menuFor(e.target);
    if (!m) return;
    e.preventDefault();
    // A keyboard-generated event carries no pointer position.
    if (!e.clientX && !e.clientY) openMenu({ anchor: m.el, returnFocus: document.activeElement }, m.items);
    else openMenu({ x: e.clientX, y: e.clientY }, m.items);
  };
  const onMenuKey = (e) => {
    if (!(e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) return;
    const m = menuFor(e.target);
    if (!m) return;
    e.preventDefault();
    keyOpened.current = Date.now();
    openMenu({ anchor: m.el, returnFocus: e.target }, m.items);
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

  // What the grid and the list share: the same files, selection and actions,
  // so switching views never changes what a click or a key does.
  const gridProps = {
    files: visible,
    selected,
    onSelect: toggleSelect,
    onOpen: openFile,
    onDragFile: canWrite ? onDragFile : undefined,
    onMissingThumb: requestThumb,
    labelFor: (f) => deriveAuto(f).format || f.kind,
    badgesFor: (f) => {
      const e = flags.usageRights ? expiryState(f, schema) : null;
      if (e === 'expired') return <span className="tag tag-danger">Expired</span>;
      if (e === 'soon') return <span className="tag tag-warning">Expiring</span>;
      return null;
    },
    emptyState: showTiles && subfolders.length > 0 && files.length === 0 ? null : (
      <div className="empty">
        {files.length === 0
          ? canWrite ? 'Nothing here yet. Drop files anywhere on this page to upload.' : 'Nothing here yet.'
          : 'No files match those filters.'}
      </div>
    ),
  };

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
      onContextMenu={onContextMenu}
      onKeyDown={onMenuKey}
    >
      <div className="row files-head" style={{ marginBottom: 20 }}>
        <h1 className="files-title" style={{ fontSize: 24, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{folder || 'All files'}</h1>
        <span className="muted small">
          {visible.length}{visible.length !== files.length ? ` of ${files.length}` : ''}{cursor ? '+' : ''}
        </span>
        {folder && canWrite && (
          <Menu label="Folder actions" align="left">
            <MenuItem onClick={() => renameFolderUI(folder)}>Rename…</MenuItem>
            <MenuItem onClick={() => moveFolderUI(folder)}>Move…</MenuItem>
            <MenuSeparator />
            <MenuItem danger onClick={() => deleteFolderUI(folder)}>Delete folder…</MenuItem>
          </Menu>
        )}
        <div className="spacer" />
        {selected.size > 0 && canWrite && (
          <button className="btn" onClick={moveSelectedUI}>
            Move {selected.size}…
          </button>
        )}
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
            <button className="btn" onClick={() => newFolder()}>New folder</button>
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
        <div className="view-toggle" role="group" aria-label="View">
          <button type="button" className="btn" aria-pressed={view === 'grid'} aria-label="Grid view" title="Grid view" onClick={() => changeView('grid')}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
          </button>
          <button type="button" className="btn" aria-pressed={view === 'list'} aria-label="List view" title="List view" onClick={() => changeView('list')}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d="M2 3.5h12M2 8h12M2 12.5h12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
          </button>
        </div>
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
            <FilespaceSwitcher filespaces={filespaces} activeId={filespaceId} isAdmin={isAdmin} onSwitch={switchFilespace} />
            <div className="side-folders">
              <Section title="Folders">
                <div className="folder-list edge-scroll">
                  <FolderDrop target="" enabled={canWrite} onDrop={onTreeDrop}>
                    <FolderLink active={!folder} onClick={() => setFolder('')} path="">All files</FolderLink>
                  </FolderDrop>
                  <FolderTree
                    folders={folders}
                    selected={folder}
                    onSelect={setFolder}
                    canWrite={canWrite}
                    onDrop={onTreeDrop}
                    storageKey={`onyx.tree.open:${filespaceId || 'all'}`}
                  />
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

          <section className="files-pane">
            {view === 'grid' && showTiles && subfolders.length > 0 && (
              <FolderTiles
                folders={subfolders}
                onOpen={setFolder}
                canWrite={canWrite}
                onDrop={onTreeDrop}
              />
            )}
            {loading ? (
              <>
                {view === 'list' && <FileListHeader sort={sort} onSort={changeSort} />}
                <div className="empty">Loading…</div>
              </>
            ) : view === 'list' ? (
              <FileList
                {...gridProps}
                sort={sort}
                onSort={changeSort}
                before={showTiles && subfolders.length > 0 ? (
                  <FolderRows folders={subfolders} onOpen={setFolder} canWrite={canWrite} onDrop={onTreeDrop} />
                ) : null}
              />
            ) : (
              <FileGrid {...gridProps} />
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
          {canWrite && <button className="btn" onClick={moveSelectedUI}>Move</button>}
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
      {promptElement}
      {pickerElement}
      {contextMenuElement}
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

function FolderLink({ active, onClick, children, draggable = false, onDragStart, path }) {
  return (
    <button
      onClick={onClick}
      data-folder={path}
      className={`small folder-link${active ? ' active' : ''}`}
      aria-current={active ? 'true' : undefined}
      draggable={draggable}
      onDragStart={onDragStart}
    >
      {children}
    </button>
  );
}

// Past this many subfolders the tree is the better way in; the tiles are not
// virtualized.
const MAX_TILES = 300;

/**
 * The open folder's subfolders as tiles above its files. Click opens; each is
 * a drop target for moves and uploads, draggable onto another folder, and
 * carries data-folder so the page's context menu finds it.
 */
function FolderTiles({ folders, onOpen, canWrite, onDrop }) {
  const shown = folders.slice(0, MAX_TILES);
  return (
    <div className="folder-tiles" role="list" aria-label="Folders">
      {shown.map((f) => (
        <FolderDrop key={f.folder} target={f.folder} enabled={canWrite} onDrop={onDrop} className="folder-tile-wrap">
          <button
            type="button"
            role="listitem"
            className="folder-tile"
            data-folder={f.folder}
            title={f.folder}
            onClick={() => onOpen(f.folder)}
            draggable={canWrite}
            onDragStart={canWrite ? (e) => {
              e.dataTransfer.setData(DRAG_FOLDER, f.folder);
              e.dataTransfer.setData('text/plain', f.folder);
              e.dataTransfer.effectAllowed = 'move';
            } : undefined}
          >
            <svg className="folder-tile-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden>
              <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.3l2 2h8.7A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            <span className="folder-tile-name truncate">{f.name}</span>
            {f.count != null && <span className="small muted">{f.count}</span>}
          </button>
        </FolderDrop>
      ))}
      {folders.length > shown.length && (
        <p className="small muted" style={{ margin: 0, alignSelf: 'center' }}>
          and {folders.length - shown.length} more in the sidebar
        </p>
      )}
    </div>
  );
}

/**
 * The list view's version of the folder tiles: the open folder's subfolders
 * as rows above its files, in the list's columns. Same behaviour as a tile —
 * click opens, drop target, draggable, data-folder for the context menu.
 */
function FolderRows({ folders, onOpen, canWrite, onDrop }) {
  const shown = folders.slice(0, MAX_TILES);
  return (
    <div className="filelist-folders" role="list" aria-label="Folders">
      {shown.map((f) => (
        <FolderDrop key={f.folder} target={f.folder} enabled={canWrite} onDrop={onDrop}>
          <button
            type="button"
            role="listitem"
            className="filelist-row filelist-cols filelist-folder"
            data-folder={f.folder}
            title={f.folder}
            onClick={() => onOpen(f.folder)}
            draggable={canWrite}
            onDragStart={canWrite ? (e) => {
              e.dataTransfer.setData(DRAG_FOLDER, f.folder);
              e.dataTransfer.setData('text/plain', f.folder);
              e.dataTransfer.effectAllowed = 'move';
            } : undefined}
          >
            <span className="filelist-thumb filelist-folder-icon" aria-hidden>
              <svg viewBox="0 0 24 24" width="20" height="20">
                <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.3l2 2h8.7A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="filelist-name"><span className="truncate">{f.name}</span></span>
            <span className="filelist-col-size muted">{f.count ? `${f.count} file${f.count === 1 ? '' : 's'}` : '—'}</span>
            <span className="filelist-col-type muted">Folder</span>
            <span className="filelist-col-modified muted" />
          </button>
        </FolderDrop>
      ))}
      {folders.length > shown.length && (
        <p className="small muted filelist-more">and {folders.length - shown.length} more in the sidebar</p>
      )}
    </div>
  );
}

const isMoveDrag = (e) => {
  const types = [...(e.dataTransfer?.types || [])];
  return types.includes(DRAG_FILES) || types.includes(DRAG_FOLDER) || types.includes('Files');
};

/**
 * A drop target in the tree. Highlights while something droppable is over
 * it; `onDragHold` fires after a moment of hovering, which the tree uses to
 * open a collapsed folder so a drop can reach its children.
 */
function FolderDrop({ target, enabled, onDrop, onDragHold, className = '', style, children }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hold = useRef(null);
  const end = () => { depth.current = 0; setOver(false); clearTimeout(hold.current); };
  if (!enabled) return <div className={className} style={style}>{children}</div>;
  return (
    <div
      className={`${className} folder-drop${over ? ' is-over' : ''}`}
      style={style}
      onDragEnter={(e) => {
        if (!isMoveDrag(e)) return;
        e.preventDefault();
        depth.current += 1;
        if (!over) {
          setOver(true);
          if (onDragHold) hold.current = setTimeout(onDragHold, 700);
        }
      }}
      onDragOver={(e) => {
        if (!isMoveDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = [...e.dataTransfer.types].includes('Files') ? 'copy' : 'move';
      }}
      onDragLeave={(e) => {
        if (!isMoveDrag(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) end();
      }}
      onDrop={(e) => {
        if (!isMoveDrag(e)) return;
        // Handled here, not by the page's upload drop as well.
        e.preventDefault();
        e.stopPropagation();
        end();
        onDrop(target, e);
      }}
    >
      {children}
    </div>
  );
}

// The folders someone has opened, per filespace, kept across visits.
function readOpen(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); }
}

/**
 * The sidebar's folders as a tree. The API sends every folder path, ancestors
 * included, with its parent. Top-level folders show; a folder's children show
 * once it is opened, and which are open is remembered per filespace. Selecting
 * a folder opens it and everything above it, so the row just chosen is on
 * screen rather than inside a collapsed branch.
 *
 * With write access, a folder can be dragged onto another to move it, and
 * files dragged from the grid (or the desktop) can be dropped on one.
 */
function FolderTree({ folders, selected, onSelect, canWrite, onDrop, storageKey }) {
  const [open, setOpen] = useState(() => new Set());
  const loaded = useRef(null);

  // Read after mount: the server render has no localStorage, and reading it
  // during the first render would mismatch the HTML.
  useEffect(() => {
    const saved = readOpen(storageKey);
    loaded.current = storageKey;
    setOpen((prev) => new Set([...saved, ...prev]));
  }, [storageKey]);

  useEffect(() => {
    if (loaded.current !== storageKey) return;
    try { localStorage.setItem(storageKey, JSON.stringify([...open].slice(0, 2000))); } catch {}
  }, [open, storageKey]);

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
  const expand = (path) => setOpen((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));

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
    const hasKids = children.has(f.folder);
    return (
      <FolderDrop
        key={f.folder}
        target={f.folder}
        enabled={canWrite}
        onDrop={onDrop}
        onDragHold={hasKids && !isOpen ? () => expand(f.folder) : undefined}
        className="folder-row"
        style={{ '--depth': depth }}
      >
        {hasKids ? (
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
        <FolderLink
          path={f.folder}
          active={selected === f.folder}
          onClick={() => onSelect(f.folder)}
          draggable={canWrite}
          onDragStart={canWrite ? (e) => {
            e.dataTransfer.setData(DRAG_FOLDER, f.folder);
            e.dataTransfer.setData('text/plain', f.folder);
            e.dataTransfer.effectAllowed = 'move';
          } : undefined}
        >
          {f.name} {f.count != null && <span className="muted">{f.count}</span>}
        </FolderLink>
      </FolderDrop>
    );
  });
}
