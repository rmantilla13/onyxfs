'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { buildFacets, fileMatchesFacets, hasAnyFacet, deriveAuto, expiryState } from '@/lib/dam';
import { createThumbnailBackfill } from '@/lib/thumbnail-client';
import { createUploadQueue, uploadOne, filesFromDrop, filesFromInput, joinFolder } from '@/lib/upload-client';
import FileGrid from '@/app/components/ui/FileGrid';
import FileList from '@/app/components/ui/FileList';
import FilterPanel, { ActiveFilters, countActive } from '@/app/components/ui/FilterPanel';
import ColumnPicker, { NewFieldDialog } from '@/app/components/ui/ColumnPicker';
import InfoDialog from '@/app/components/ui/InfoDialog';
import ShareDialog from '@/app/components/ShareDialog';
import { DriveList, NewDriveDialog, DriveMembersDialog } from '@/app/components/Drives';
import { modKey, isTyping } from '@/lib/keys';
import { fmtSize } from '@/lib/media';
import { listingCache, listingKey } from '@/lib/listing-cache';
import {
  VIEW_STORAGE_KEY, parseView, availableColumns, parseColumns, resolveColumns,
  COLUMNS_STORAGE_KEY, DEFAULT_COLUMNS, METADATA_PREFIX,
} from '@/lib/list-columns';
import UploadPanel from '@/app/components/ui/UploadPanel';
import { useToast } from '@/app/components/ui/Toast';
import { useConfirm } from '@/app/components/ui/Confirm';
import { usePrompt } from '@/app/components/ui/Prompt';
import { useFolderPicker } from '@/app/components/ui/FolderPicker';
import Menu, { MenuItem, MenuSeparator } from '@/app/components/ui/Menu';
import { useContextMenu } from '@/app/components/ui/ContextMenu';
import useMarquee from '@/app/components/ui/useMarquee';
import useMacApp from '@/app/components/useMacApp';
import { canFor, canForSome } from './can-for';
import {
  folderNameProblem, fileNameProblem, parentOf, baseName, isWithin, rebase, mapLimit, cleanFolder, crumbsFor, folderStats,
} from '@/lib/folder-ops';

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
// What a drag-to-select may not start on: anything with a press of its own.
const MARQUEE_SKIP = [
  '[data-file-id]', '[data-folder]', '[data-drive]', 'a', 'button', 'input', 'textarea', 'select', 'label',
  '[contenteditable]', '[role="button"]', '.filelist-head', '.ctx-menu', '.menu', '.cell-pop', 'dialog',
].join(', ');

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// How many files Select all will load and select in one go. Beyond it, a
// folder is moved a few thousand at a time.
const SELECT_ALL_CAP = 5000;
// Moves in flight at once: each is a copy and a delete in the bucket.
const MOVE_PARALLEL = 6;

// Whether the filter panel was left open, per browser.
const FILTERS_STORAGE_KEY = 'onyx.files.filters';

// Where the open folder came from, kept in the history entry itself. Only
// our keys are passed: Next.js copies its own in, and an object that already
// carries them is taken for one of Next's internal writes and not synced to
// useSearchParams (see the pushState patch in next/dist/.../app-router).
const historyState = () => {
  const s = typeof window !== 'undefined' ? window.history.state : null;
  return { depth: Number(s?.onyxDepth) || 0, from: typeof s?.onyxFrom === 'string' ? s.onyxFrom : null };
};

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


/**
 * One page of a listing from GET /api/files: { files, cursor }. The same
 * request whether it is for the folder on screen or a prefetch.
 *
 * A folder lists what is in it, like a disk: its own files, with its
 * subfolders as tiles — at the top level too, which used to list every file
 * in the library, so an uploaded folder's files looked as if they had been
 * poured out beside it. Searching or filtering by kind looks through
 * everything beneath the folder instead: that is a search, and a search
 * that stops at one level finds nothing.
 */
async function fetchListing({ filespaceId, folder, query, kinds, sort }, after = null) {
  const p = new URLSearchParams();
  if (query || kinds.length) {
    if (folder) p.set('folderPrefix', folder);
  } else {
    p.set('folder', folder || '');
  }
  if (query) p.set('q', query);
  if (kinds.length) p.set('kind', kinds.join(','));
  p.set('sort', sort);
  if (filespaceId) p.set('filespace', filespaceId);
  if (after) p.set('cursor', after);
  p.set('folders', '0');
  const r = await fetch(`/api/files?${p}`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Request failed (${r.status})`);
  const data = await r.json();
  return { files: data.files || [], cursor: data.cursor || null };
}

/**
 * `drives` are the filespaces this person may open (listFilespacesForSpace);
 * `filespaceId` is the drive being shown ('' is All files).
 *
 * `initial` is what the server already rendered (app/files/page.js): the
 * first page of the folder in the URL and the folder tree, so the directory
 * is on screen in the first paint. Its `key` (listingKey) says which listing
 * it answers; a drive switch brings a new one.
 */
export default function FilesClient({
  flags, canWrite, schema: initialSchema, filespaceId, isAdmin = false,
  drives = [], initial = null,
}) {
  const [files, setFiles] = useState(() => initial?.files || []);
  const [folders, setFolders] = useState(() => initial?.folders || []);
  const [loading, setLoading] = useState(!initial);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState(() => initial?.cursor || null);
  // Drive and library usage for the drive list: asked for after the page is
  // on screen (/api/filespaces/usage), never while it renders.
  const [usage, setUsage] = useState({ usage: {}, library: null });
  const driveUsage = usage.usage;
  const [error, setError] = useState(null);
  // State rather than the prop alone: adding a field from the list's column
  // picker extends it without a reload.
  const [schema, setSchema] = useState(initialSchema);

  // The open folder lives in the URL (?folder=), so a folder is a link that
  // survives a reload, and the browser's Back and Forward — the mouse's back
  // button, ⌘[ — walk between folders the way they do between pages.
  const searchParams = useSearchParams();
  const folder = cleanFolder(searchParams.get('folder') || '');
  const [nav, setNav] = useState({ depth: 0, from: null });
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState([]);
  const [sort, setSort] = useState('new');
  // Grid or list. Starts as grid on the server and in the first client
  // render, then takes the stored choice after mount — reading localStorage
  // during render would disagree with the server HTML and fail hydration.
  const [view, setView] = useState('grid');
  const [facets, setFacets] = useState({});
  const [selected, setSelected] = useState(new Set());
  // The Mac app's offline and Finder actions, when running inside it.
  const mac = useMacApp();
  const [uploadSnap, setUploadSnap] = useState(null);
  const [dragging, setDragging] = useState(false);
  // The facet filters live in a panel under the toolbar, open only while
  // someone is adjusting them; what is applied shows as chips when it is shut.
  const [filtersOpen, setFiltersOpen] = useState(false);
  // The list view's columns, as keys (lib/list-columns.js).
  const [columnKeys, setColumnKeys] = useState(DEFAULT_COLUMNS);
  const [addingField, setAddingField] = useState(false);
  // What "Get info" is showing, if anything (InfoDialog).
  const [info, setInfo] = useState(null);
  // The file the Share dialog is open for.
  const [sharing, setSharing] = useState(null);
  // Drives: the New drive dialog, and the drive whose members are open.
  const [newDrive, setNewDrive] = useState(false);
  const [membersOf, setMembersOf] = useState(null);
  const activeDrive = drives.find((d) => d.id === filespaceId) || null;
  // The top of whatever is being shown: a drive's name, or the library.
  const rootName = activeDrive?.name || 'All files';
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

  // Which listing is on screen, as a key: the cache (lib/listing-cache.js)
  // and the server-rendered first page are both matched against it.
  const currentKey = listingKey({ filespaceId, folder, query, kinds, sort });

  /**
   * Fetch one page. `after` is the opaque cursor from the previous page; with
   * no cursor this is a fresh query and replaces the grid rather than
   * appending to it. `quiet` keeps the grid up while it refetches, for the
   * refreshes an upload batch triggers as files land. A first page is kept
   * in the listing cache, so coming back to it is instant.
   */
  const fetchPage = useCallback(async (after = null, quiet = false) => {
    const token = ++requestRef.current;
    const key = listingKey({ filespaceId, folder, query, kinds, sort });
    if (after) setLoadingMore(true);
    else if (!quiet) setLoading(true);
    setError(null);
    try {
      const data = await fetchListing({ filespaceId, folder, query, kinds, sort }, after);
      if (!after) listingCache.set(key, data);
      if (token !== requestRef.current) return; // superseded
      setFiles((prev) => (after ? [...prev, ...(data.files || [])] : data.files || []));
      setCursor(data.cursor || null);
    } catch (e) {
      if (token === requestRef.current) setError(e.message);
    } finally {
      if (token === requestRef.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [folder, query, kinds, sort, filespaceId]);

  // After anything that changes files: drop every cached listing (which
  // folders a move or an upload touched is not worth working out) and fetch.
  const load = useCallback(() => { listingCache.clear(); return fetchPage(null); }, [fetchPage]);
  const refresh = useCallback(() => { listingCache.clear(); return fetchPage(null, true); }, [fetchPage]);

  // Opening a folder, changing the sort, searching: from the cache when it
  // has this listing — at once, and refetched quietly behind it if it is not
  // fresh — and from the network when it does not.
  const show = useCallback(() => {
    const hit = listingCache.get(currentKey);
    if (!hit) return fetchPage(null);
    ++requestRef.current; // a slower answer for where we were must not land here
    setFiles(hit.files || []);
    setCursor(hit.cursor || null);
    setLoading(false);
    setError(null);
    if (!hit.fresh) fetchPage(null, true);
    return undefined;
  }, [currentKey, fetchPage]);

  // Prefetch: pointing at a folder for a moment fetches its first page into
  // the cache, so the click that follows shows it with no wait. One at a
  // time, and not for a listing the cache already has fresh.
  const prefetching = useRef(null);
  const prefetch = useCallback((path) => {
    const params = { filespaceId, folder: path, query, kinds, sort };
    const key = listingKey(params);
    if (listingCache.isFresh(key) || prefetching.current === key) return;
    prefetching.current = key;
    fetchListing(params)
      .then((data) => listingCache.set(key, data))
      .catch(() => {})
      .finally(() => { if (prefetching.current === key) prefetching.current = null; });
  }, [filespaceId, query, kinds, sort]);
  const hover = useRef({ path: null, timer: null });
  const onFolderHover = (e) => {
    const el = e.target?.closest?.('[data-folder]');
    const path = el ? cleanFolder(el.dataset.folder || '') : null;
    if (path === hover.current.path) return;
    hover.current.path = path;
    clearTimeout(hover.current.timer);
    if (path === null || path === folder) return;
    hover.current.timer = setTimeout(() => prefetch(path), 70);
  };
  useEffect(() => () => clearTimeout(hover.current.timer), []);

  // The folder tree, loaded once per filespace and again only after an upload
  // or a removal changes what is in a folder. It used to ride along with every
  // first page, so each filter change and search keystroke re-counted the
  // whole library and downloaded a couple of hundred kilobytes of tree.
  const loadUsage = useCallback(async () => {
    try {
      const r = await fetch('/api/filespaces/usage');
      if (r.ok) setUsage(await r.json());
    } catch {}
  }, []);

  const loadFolders = useCallback(async () => {
    loadUsage();
    try {
      const r = await fetch(`/api/files/folders${filespaceId ? `?filespace=${encodeURIComponent(filespaceId)}` : ''}`);
      if (!r.ok) return;
      const data = await r.json();
      setFolders(data.folders || []);
    } catch {}
  }, [filespaceId, loadUsage]);

  // What the server rendered — on first load, and again on each drive switch,
  // which is a server render too. Its first page goes into the cache (so the
  // listing effect below finds it and does not fetch), and its tree is the
  // tree. Declared before the effects that would otherwise fetch both.
  const treeFor = useRef(null);
  const keyRef = useRef(currentKey);
  keyRef.current = currentKey;
  useEffect(() => {
    if (!initial) return;
    listingCache.set(initial.key, { files: initial.files, cursor: initial.cursor });
    setFolders(initial.folders || []);
    treeFor.current = initial.filespaceId;
    // A server render of the listing already on screen (router.refresh) is
    // fresher than what is showing: take it.
    if (initial.key === keyRef.current) {
      ++requestRef.current;
      setFiles(initial.files || []);
      setCursor(initial.cursor || null);
      setLoading(false);
    }
  }, [initial]);

  useEffect(() => {
    if (treeFor.current === filespaceId) { loadUsage(); return; }
    loadFolders();
  }, [loadFolders, loadUsage, filespaceId]);

  useEffect(() => {
    try { setView(parseView(localStorage.getItem(VIEW_STORAGE_KEY))); } catch {}
    try { setFiltersOpen(localStorage.getItem(FILTERS_STORAGE_KEY) === 'open'); } catch {}
  }, []);
  const changeView = (next) => {
    setView(next);
    try { localStorage.setItem(VIEW_STORAGE_KEY, next); } catch {}
  };
  const toggleFilters = (open = !filtersOpen) => {
    setFiltersOpen(open);
    try { localStorage.setItem(FILTERS_STORAGE_KEY, open ? 'open' : 'closed'); } catch {}
  };

  // ── Columns (list view) ───────────────────────────────────────────────────
  // Stored per browser, like the grid/list choice, and read after mount for
  // the same hydration reason. Metadata columns follow the feature flag.
  const available = useMemo(() => availableColumns(schema, { metadata: !!flags.metadata }), [schema, flags.metadata]);
  useEffect(() => {
    try { setColumnKeys(parseColumns(localStorage.getItem(COLUMNS_STORAGE_KEY), available)); } catch {}
  }, [available]);
  const changeColumns = useCallback((keys) => {
    setColumnKeys(keys);
    try { localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(keys)); } catch {}
  }, []);
  const columns = useMemo(() => resolveColumns(columnKeys, available), [columnKeys, available]);

  // ── Folder navigation ─────────────────────────────────────────────────────
  // Opening a folder pushes a history entry; a correction — the folder was
  // renamed or deleted under us — replaces the current one, so Back never
  // leads to a path that no longer exists. Pushed through window.history
  // rather than router.push: Next keeps useSearchParams in step with it and
  // skips a server round trip for what is only a change of folder.
  const navigate = useCallback((path, { replace = false } = {}) => {
    const next = cleanFolder(path);
    const params = new URLSearchParams(window.location.search);
    if (next) params.set('folder', next);
    else params.delete('folder');
    const qs = params.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
    const cur = historyState();
    if (replace) {
      window.history.replaceState({ onyxDepth: cur.depth, onyxFrom: cur.from }, '', url);
      return;
    }
    if (next === folder) return;
    const entry = { depth: cur.depth + 1, from: folder };
    window.history.pushState({ onyxDepth: entry.depth, onyxFrom: entry.from }, '', url);
    setNav(entry);
  }, [folder]);

  useEffect(() => {
    const sync = () => setNav(historyState());
    sync();
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  // Back is history when we put the previous folder there; opened from a link
  // (nothing of ours to go back through), it is the enclosing folder instead.
  const back = nav.depth > 0
    ? { label: `Back to ${nav.from ? baseName(nav.from) : rootName}`, go: () => window.history.back() }
    : folder
      ? { label: `Up to ${parentOf(folder) ? baseName(parentOf(folder)) : rootName}`, go: () => navigate(parentOf(folder)) }
      : null;

  // Drop the selection whenever the result set changes underneath it.
  // Without this, switching folders with 40 files selected left "Trash 40"
  // acting on rows that were no longer on screen.
  useEffect(() => { setSelected(new Set()); }, [folder, query, kinds, filespaceId]);

  // Debounce so typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(show, query ? 250 : 0);
    return () => clearTimeout(t);
  }, [show, query]);

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
    navigate(joinFolder(parent, created));
    toast.success(`Folder “${created}” created.`);
  };

  // After a folder moves, anything that pointed into it follows.
  const followFolder = (from, to) => {
    if (isWithin(folder, from)) navigate(rebase(folder, from, to), { replace: true });
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
    if (isWithin(folder, path) && !failed && !lastError) navigate(parentOf(path), { replace: true });
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
    // A big move takes a while — each file is a copy and a delete in the
    // bucket — so it says it is happening rather than looking stuck.
    const note = list.length > 20
      ? toast.push(`Moving ${list.length.toLocaleString()} files to ${dest || rootName}…`, { duration: 0 })
      : null;
    await mapLimit(list, MOVE_PARALLEL, async (id) => {
      const r = await fetch(`/api/files/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folder: dest, filespaceId: fsBody }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { failed++; firstError ||= body.error || `HTTP ${r.status}`; }
      else if (body.objectMoved === false) catalogOnly++;
    });
    if (note) toast.dismiss(note);
    setSelected(new Set());
    load();
    loadFolders();
    const n = list.length - failed;
    const where = dest || rootName;
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

  // A card drag carries the whole selection when the card is part of it, and
  // says so: dragging a hundred files under the image of one reads as
  // dragging one.
  const onDragFile = useCallback((f, e) => {
    const ids = selected.has(f.id) ? [...selected] : [f.id];
    e.dataTransfer.setData(DRAG_FILES, JSON.stringify(ids));
    e.dataTransfer.setData('text/plain', ids.length === 1 ? f.name : `${ids.length} files`);
    e.dataTransfer.effectAllowed = 'move';
    if (ids.length > 1 && e.dataTransfer.setDragImage) {
      const badge = document.createElement('div');
      badge.className = 'drag-badge';
      badge.textContent = `Moving ${ids.length.toLocaleString()} files`;
      document.body.appendChild(badge);
      e.dataTransfer.setDragImage(badge, 18, 18);
      // The browser snapshots it during this event; it can go right after.
      setTimeout(() => badge.remove(), 0);
    }
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
  // Select all means the whole folder, not the hundred rows loaded so far:
  // the rest are fetched first (up to SELECT_ALL_CAP), so a select-all and a
  // drag moves everything in it. A filter narrows it as it does the grid.
  const [selectingAll, setSelectingAll] = useState(false);
  const selectAll = async () => {
    let rows = files;
    let after = cursor;
    if (after) {
      const token = requestRef.current;
      setSelectingAll(true);
      try {
        while (after && rows.length < SELECT_ALL_CAP) {
          const page = await fetchListing({ filespaceId, folder, query, kinds, sort }, after);
          if (token !== requestRef.current) return; // the listing changed under us
          rows = [...rows, ...page.files];
          after = page.cursor;
        }
        setFiles(rows);
        setCursor(after);
      } catch (e) {
        toast.error(`Could not load the rest of this folder: ${e.message}`);
      } finally {
        setSelectingAll(false);
      }
    }
    const pick = hasAnyFacet(facets) ? rows.filter((f) => fileMatchesFacets(f, facets, schema)) : rows;
    setSelected(new Set(pick.map((f) => f.id)));
    if (after) toast.success(`Selected the first ${pick.length.toLocaleString()}. Move them, then select all again for the rest.`);
  };

  // ── Get info ──────────────────────────────────────────────────────────────
  // From what the page already holds: the loaded rows and the folder tree.
  const infoForFiles = (ids) => {
    const list = files.filter((f) => ids.includes(f.id));
    if (list.length === 1) setInfo({ type: 'file', file: list[0] });
    else if (list.length) setInfo({ type: 'files', files: list });
  };
  const infoForFolder = (path) => setInfo({
    type: 'folder', path, stats: folderStats(folders, path), canOpen: path !== folder,
  });

  // Per file, the server's word on what may be done to it (./can-for.js):
  // a Member is not offered Rename on a colleague's file the route refuses.
  const fileMenu = (f) => {
    const many = selected.has(f.id) && selected.size > 1 ? [...selected] : null;
    if (many) {
      const allPinned = many.every((id) => mac.pinned.has(id));
      const canMove = canForSome(many, files, 'edit', { canWrite });
      const canDelete = canForSome(many, files, 'delete', { canWrite });
      return [
        { heading: `${many.length} files selected` },
        { label: 'Get info', hint: `${modKey()}I`, onSelect: () => infoForFiles(many) },
        mac.inApp && (allPinned
          ? { label: `Remove ${many.length} offline copies`, onSelect: () => mac.unpinFiles(many, filespaceId) }
          : { label: `Keep ${many.length} files offline on this Mac`, onSelect: () => mac.pinFiles(many, filespaceId) }),
        canMove && { label: `Move ${many.length} files…`, onSelect: () => moveFilesUI(many) },
        { label: 'Clear selection', onSelect: () => setSelected(new Set()) },
        canDelete && '-',
        canDelete && { label: `Delete ${many.length} files…`, danger: true, onSelect: () => removeFiles(many) },
      ];
    }
    const can = canFor(f, { canWrite });
    return [
      { heading: f.name },
      { label: 'Open', hint: 'Enter', onSelect: () => openFile(f) },
      { label: 'Get info', hint: `${modKey()}I`, onSelect: () => infoForFiles([f.id]) },
      { label: 'Download', onSelect: () => downloadFile(f) },
      // In the Mac app only: a copy on this Mac that opens without a connection.
      mac.inApp && (mac.pinned.has(f.id)
        ? { label: 'Remove offline copy', onSelect: () => mac.unpinFiles([f.id], filespaceId) }
        : { label: 'Keep offline on this Mac', onSelect: () => mac.pinFiles([f.id], filespaceId) }),
      // The flag is the role's (the page computed it); the route checks both
      // it and write access to this file again.
      flags.shares && can.share && { label: 'Share…', onSelect: () => setSharing(f) },
      can.edit && '-',
      can.edit && { label: 'Rename…', onSelect: () => renameFileUI(f) },
      can.edit && { label: 'Move…', onSelect: () => moveFilesUI([f.id]) },
      { label: selected.has(f.id) ? 'Deselect' : 'Select', hint: 'Space', onSelect: () => toggleSelect(f) },
      can.delete && '-',
      can.delete && { label: 'Delete…', danger: true, onSelect: () => removeFiles([f.id]) },
    ];
  };

  const folderMenu = (path) => [
    { heading: baseName(path) },
    { label: 'Open', onSelect: () => navigate(path) },
    { label: 'Get info', onSelect: () => infoForFolder(path) },
    mac.inApp && (mac.folderPinned(path, filespaceId)
      ? { label: 'Remove offline copies', onSelect: () => mac.pinFolder(path, filespaceId, false) }
      : { label: 'Keep folder offline on this Mac', onSelect: () => mac.pinFolder(path, filespaceId, true) }),
    canWrite && '-',
    canWrite && { label: 'New folder inside…', onSelect: () => newFolder(path) },
    canWrite && { label: 'Rename…', onSelect: () => renameFolderUI(path) },
    canWrite && { label: 'Move…', onSelect: () => moveFolderUI(path) },
    canWrite && '-',
    canWrite && { label: 'Delete folder…', danger: true, onSelect: () => deleteFolderUI(path) },
  ];

  // The menu for empty space — anywhere on the page that is not a file, a
  // folder or a field. `at` is the folder it acts on: the open one, or the
  // root when it came from the "All files" crumb or tree row.
  const blankMenu = (at = folder) => [
    { heading: at || rootName },
    canWrite && { label: 'New folder…', onSelect: () => newFolder(at) },
    canWrite && { label: 'Upload files…', onSelect: () => inputRef.current?.click() },
    canWrite && { label: 'Upload folder…', onSelect: () => folderInputRef.current?.click() },
    canWrite && '-',
    { label: 'Get info', hint: at === folder ? `${modKey()}I` : undefined, onSelect: () => infoForFolder(at) },
    at === folder && at && { label: 'Enclosing folder', hint: `${modKey()}↑`, onSelect: () => navigate(parentOf(at)) },
    { label: view === 'list' ? 'View as grid' : 'View as list', onSelect: () => changeView(view === 'list' ? 'grid' : 'list') },
    flags.metadata && { label: filtersOpen ? 'Hide filters' : 'Show filters', onSelect: () => toggleFilters() },
    '-',
    { label: 'Select all', hint: `${modKey()}A`, disabled: !visible.length, onSelect: selectAll },
    selected.size > 0 && { label: 'Clear selection', onSelect: () => setSelected(new Set()) },
    { label: 'Refresh', onSelect: () => { load(); loadFolders(); } },
  ];

  // ── Drives ────────────────────────────────────────────────────────────────
  // Each drive is a filespace: its own place in the bucket, its own members,
  // its own volume on the desktop. Opening one is a page change (the server
  // scopes the listing to it); making, renaming and deleting are admin
  // routes, and members are managed by admins and the drive's owners.
  const openDrive = useCallback((id) => {
    router.push(id ? `/files?filespace=${encodeURIComponent(id)}` : '/files');
  }, [router]);
  const canManageDrive = (d) => isAdmin || d?.role === 'owner';

  const infoForDrive = (d) => setInfo({
    type: 'drive', drive: d, usage: driveUsage[d.id] || null, canManage: canManageDrive(d), isAdmin,
  });

  const renameDrive = async (d) => {
    const renamed = await prompt({
      title: 'Rename drive',
      label: 'Name',
      value: d.name,
      confirmLabel: 'Rename',
      validate: (v) => (v.trim() ? null : 'Give the drive a name.'),
      submit: async (name) => {
        const r = await fetch('/api/admin/filespaces', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: d.id, name: name.trim() }),
        });
        return r.ok ? null : (await r.json().catch(() => ({}))).error || `Could not rename the drive (HTTP ${r.status}).`;
      },
    });
    if (renamed == null) return;
    router.refresh();
    toast.success(`Renamed to “${renamed.trim()}”.`);
  };

  const deleteDrive = async (d) => {
    const u = driveUsage[d.id];
    const ok = await confirm({
      title: `Delete the drive “${d.name}”?`,
      body: `Its members lose it, and desktop mounts of it stop within the hour. ${u?.files
        ? `The ${u.files} file${u.files === 1 ? '' : 's'} in it (${fmtSize(u.bytes) || '0 B'}) are not deleted: they stay in the bucket and in All files.`
        : 'Nothing in the bucket is deleted.'}`,
      confirmLabel: 'Delete drive',
    });
    if (!ok) return;
    const r = await fetch(`/api/admin/filespaces?id=${encodeURIComponent(d.id)}`, { method: 'DELETE' });
    if (!r.ok) {
      toast.error((await r.json().catch(() => ({}))).error || `Could not delete the drive (HTTP ${r.status}).`);
      return;
    }
    toast.success(`Deleted the drive “${d.name}”.`);
    if (d.id === filespaceId) openDrive('');
    router.refresh();
  };

  const driveMenu = (d) => [
    { heading: d.name },
    { label: 'Open', onSelect: () => openDrive(d.id) },
    { label: 'Get info', onSelect: () => infoForDrive(d) },
    mac.inApp && !mac.mounted.has(mac.scopeOf(d.id)) && { label: 'Show in Finder', onSelect: () => mac.showInFinder(d.id, d.name) },
    mac.inApp && (mac.folderPinned('', d.id)
      ? { label: 'Remove offline copies', onSelect: () => mac.pinFolder('', d.id, false) }
      : { label: 'Keep whole drive offline', onSelect: () => mac.pinFolder('', d.id, true) }),
    canManageDrive(d) && '-',
    canManageDrive(d) && { label: 'Members and permissions…', onSelect: () => setMembersOf(d) },
    isAdmin && { label: 'Rename…', onSelect: () => renameDrive(d) },
    isAdmin && { label: 'Bucket and keys…', onSelect: () => router.push('/admin?tab=filespaces') },
    isAdmin && '-',
    isAdmin && { label: 'Delete drive…', danger: true, onSelect: () => deleteDrive(d) },
  ];

  const libraryMenu = () => [
    { heading: 'All files' },
    { label: 'Open', onSelect: () => openDrive('') },
    isAdmin && '-',
    isAdmin && { label: 'New drive…', onSelect: () => setNewDrive(true) },
  ];

  // The ⌘K palette's actions for this page arrive as `onyx:command` events
  // (CommandPalette). Through a ref, like the page keys, so the listener is
  // added once and still acts on this render's folder and selection.
  const commands = useRef(null);
  commands.current = (name) => {
    if (name === 'new-folder' && canWrite) newFolder();
    else if (name === 'upload' && canWrite) inputRef.current?.click();
    else if (name === 'info') (selected.size ? infoForFiles([...selected]) : infoForFolder(folder));
    else if (name === 'new-drive' && isAdmin) setNewDrive(true);
  };
  useEffect(() => {
    const on = (e) => commands.current?.(e.detail?.name);
    window.addEventListener('onyx:command', on);
    return () => window.removeEventListener('onyx:command', on);
  }, []);

  // /files?new=drive — the palette's New drive from another page. Opens the
  // dialog once and takes the parameter back off, so a reload does not.
  useEffect(() => {
    if (searchParams.get('new') !== 'drive') return;
    if (isAdmin) setNewDrive(true);
    const params = new URLSearchParams(window.location.search);
    params.delete('new');
    const qs = params.toString();
    // Our keys only, as in navigate(), so Next brings useSearchParams along.
    const cur = historyState();
    window.history.replaceState({ onyxDepth: cur.depth, onyxFrom: cur.from }, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  }, [searchParams, isAdmin]);

  // Fields, links and open menus keep the browser's own menu — copy, paste,
  // open in a new tab. Everything else on the page gets ours.
  const menuFor = (target) => {
    if (target?.closest?.('input, textarea, select, [contenteditable], a[href], .ctx-menu, .cell-pop, dialog')) return null;
    const card = target?.closest?.('[data-file-id]');
    if (card) {
      const f = files.find((x) => x.id === card.dataset.fileId);
      return f ? { el: card, items: fileMenu(f) } : null;
    }
    const disk = target?.closest?.('[data-drive]');
    if (disk) {
      const d = drives.find((x) => x.id === disk.dataset.drive);
      return { el: disk, items: d ? driveMenu(d) : libraryMenu() };
    }
    const dir = target?.closest?.('[data-folder]');
    if (dir) {
      const path = dir.dataset.folder;
      return { el: dir, items: path ? folderMenu(path) : blankMenu('') };
    }
    return { el: target?.closest?.('.files-pane') || target, items: blankMenu() };
  };

  // Page shortcuts, listed in the nav's Shortcuts dialog:
  //   ⌘↑ / Ctrl+↑ / Alt+↑  the enclosing folder, as in Finder. Back and
  //                        Forward (⌘[ ⌘], Alt+← →) are the browser's own,
  //                        now that folders are history.
  //   ⌘I / Ctrl+I          Get info: the selection, else the file with
  //                        focus, else the open folder.
  // Through a ref, so the listener is added once and still sees this
  // render's selection and folder.
  const pageKeys = useRef(null);
  pageKeys.current = (e) => {
    if (e.defaultPrevented || isTyping(e) || e.target?.closest?.('dialog')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'ArrowUp' && (mod || e.altKey) && !e.shiftKey) {
      if (!folder) return;
      e.preventDefault();
      navigate(parentOf(folder));
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && (e.key === 'i' || e.key === 'I')) {
      e.preventDefault();
      const focused = document.activeElement?.closest?.('[data-file-id]')?.dataset.fileId;
      if (selected.size) infoForFiles([...selected]);
      else if (focused) infoForFiles([focused]);
      else infoForFolder(folder);
      return;
    }
    // ⌘A: every file in the folder, as in Finder — then drag any one of them
    // to move the lot. Esc lets go of a selection.
    if (mod && !e.altKey && !e.shiftKey && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      selectAll();
      return;
    }
    if (e.key === 'Escape' && selected.size && !e.target?.closest?.('.ctx-menu, .menu')) {
      setSelected(new Set());
    }
  };
  useEffect(() => {
    const onKey = (e) => pageKeys.current?.(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
  // is seen by someone who may edit them, and files whose thumbnail is one of
  // the old small ones get a sharper one. See lib/thumbnail-client.js.
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

  // ── Editing from the list ─────────────────────────────────────────────────
  // An edit shows at once and is put back if the server refuses it. PATCH
  // merges metadata (updateFile in lib/db.js), so only the edited field is
  // sent, and null clears it; tags go as the whole list, which is what the
  // column edits.
  const editCell = useCallback(async (f, col, value) => {
    const isTags = col.key === 'tags';
    const key = col.field?.key;
    const apply = (x, v) => (isTags ? { ...x, tags: v || [] } : { ...x, metadata: { ...(x.metadata || {}), [key]: v } });
    const previous = isTags ? f.tags : f.metadata?.[key];
    setFiles((prev) => prev.map((x) => (x.id === f.id ? apply(x, value) : x)));
    try {
      const r = await fetch(`/api/files/${f.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(isTags ? { tags: value || [] } : { metadata: { [key]: value } }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(body.error === 'No access' ? 'You can view this file but not edit it.' : body.error || `HTTP ${r.status}.`);
      }
      // The row as stored — tags lowercased, a cleared field as null — but
      // keeping the signed URLs the list holds; the PATCH row is unsigned.
      const saved = body.file || {};
      setFiles((prev) => prev.map((x) => (x.id === f.id
        ? { ...x, tags: saved.tags ?? x.tags, metadata: saved.metadata ?? x.metadata, version: saved.version ?? x.version, updatedAt: saved.updatedAt ?? x.updatedAt }
        : x)));
    } catch (e) {
      setFiles((prev) => prev.map((x) => (x.id === f.id ? apply(x, previous) : x)));
      toast.error(`${col.label} was not saved. ${e.message}`);
    }
  }, [toast]);

  // What an editor offers: the values already in use across the loaded files.
  const suggestionsFor = useCallback((col) => {
    const key = col.key === 'tags' ? 'tags' : col.field?.key;
    const def = facetDefs.find((d) => d.key === key);
    return def ? def.values.map((v) => v.value) : [];
  }, [facetDefs]);

  // Admins only; the route checks again. The field arrives as a column that
  // is already shown, so filling it in is the next thing on screen.
  const createField = useCallback(async (spec) => {
    const r = await fetch('/api/admin/metadata', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spec),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return body.error || `Could not add the field (HTTP ${r.status}).`;
    const key = `${METADATA_PREFIX}${body.field.key}`;
    changeColumns([...columnKeys.filter((k) => k !== key), key]);
    setSchema(body.schema);
    setAddingField(false);
    toast.success(`Added “${body.field.label}”. Click a cell in its column to fill it in.`);
    return null;
  }, [columnKeys, changeColumns, toast]);

  // ── Drag to select ────────────────────────────────────────────────────────
  // A press on empty space in the listing — the gaps between cards, the room
  // around and below them — and a drag draws a selection rectangle
  // (useMarquee). Cards, rows, folders and controls keep their own presses:
  // dragging a card still moves it. The grid or list says which of its items
  // the rectangle touches (marqueeTarget), from its layout.
  const paneRef = useRef(null);
  const marqueeTarget = useRef(null);
  const marquee = useMarquee({
    canStart: (e) => {
      const t = e.target;
      if (!(t instanceof Element) || t.closest(MARQUEE_SKIP)) return false;
      const pane = paneRef.current;
      if (!pane) return false;
      if (pane.contains(t)) return true;
      // The page itself below or beside the listing counts too — the gutter
      // between the sidebar and the first card included — as long as it is
      // level with the pane and clear of the sidebar.
      if (t === e.currentTarget || t.classList.contains('files-layout')) {
        const b = pane.getBoundingClientRect();
        const side = e.currentTarget.querySelector('.files-layout > aside')?.getBoundingClientRect();
        return e.clientY >= b.top && e.clientX > (side && side.width ? side.right : b.left - 1);
      }
      return false;
    },
    hitsIn: (rect) => marqueeTarget.current?.hitsIn(rect) || [],
    getSelection: () => selected,
    onSelect: (indices, { base, additive }) => {
      const next = new Set(additive ? base : []);
      for (const i of indices) if (visible[i]) next.add(visible[i].id);
      setSelected((prev) => (sameSet(prev, next) ? prev : next));
    },
    onClear: () => setSelected((prev) => (prev.size ? new Set() : prev)),
  });

  // What the grid and the list share: the same files, selection and actions,
  // so switching views never changes what a click or a key does.
  const gridProps = {
    marqueeRef: marqueeTarget,
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
      onPointerOver={onFolderHover}
      onFocus={onFolderHover}
      onPointerDown={marquee.onPointerDown}
    >
      <div className="row files-head" style={{ marginBottom: 20 }}>
        {/* All files is the top of the tree: nothing to go back up to, so no
            button — the heading sits flush with the page. Inside a folder,
            Back is history when there is some and the enclosing folder when
            there is not. */}
        {folder && (
          <button
            type="button"
            className="btn btn-ghost btn-icon files-back"
            onClick={back?.go}
            aria-label={back?.label || 'Back'}
            title={back?.label}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
              <path d="M9.5 3.5 5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <Breadcrumbs folder={folder} rootName={rootName} onOpen={navigate} canWrite={canWrite} onDrop={onTreeDrop} />
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
        {selected.size > 0 && (selected.size < visible.length || cursor) && (
          <button className="btn btn-ghost" onClick={selectAll} disabled={selectingAll} title={`Select all (${modKey()}A)`}>
            {selectingAll ? 'Selecting…' : 'Select all'}
          </button>
        )}
        {selected.size > 0 && canForSome(selected, files, 'edit', { canWrite }) && (
          <button className="btn" onClick={moveSelectedUI}>
            Move {selected.size}…
          </button>
        )}
        {selected.size > 0 && canForSome(selected, files, 'delete', { canWrite }) && (
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
        {flags.metadata && (
          <button
            type="button"
            className={`btn files-filters-btn${filtersOpen ? ' is-open' : ''}`}
            onClick={() => toggleFilters()}
            aria-expanded={filtersOpen}
            aria-controls="files-filters"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path d="M2 4h12M4.5 8h7M7 12h2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            Filters
            {hasAnyFacet(facets) && <span className="count-badge">{countActive(facets)}</span>}
          </button>
        )}
        </div>
      </div>

      {flags.metadata && (filtersOpen ? (
        <FilterPanel
          id="files-filters"
          defs={facetDefs}
          selected={facets}
          onToggle={toggleFacet}
          onClear={() => setFacets({})}
          onClose={() => toggleFilters(false)}
        />
      ) : (
        <ActiveFilters
          defs={facetDefs}
          selected={facets}
          onToggle={toggleFacet}
          onClear={() => setFacets({})}
          onEdit={() => toggleFilters(true)}
        />
      ))}

      {error && (
        <div className="card" style={{ padding: 16, marginBottom: 16, borderColor: 'var(--danger)' }}>
          <p className="small" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p>
        </div>
      )}

      <div className="files-layout">
          <aside>
            <DriveList
              drives={drives}
              usage={driveUsage}
              library={usage.library}
              activeId={filespaceId}
              canCreate={isAdmin}
              onOpen={openDrive}
              onNew={() => setNewDrive(true)}
            />
            <div className="side-folders">
              <Section title={activeDrive ? `Folders in ${activeDrive.name}` : 'Folders'}>
                <div className="folder-list edge-scroll">
                  <FolderDrop target="" enabled={canWrite} onDrop={onTreeDrop}>
                    <FolderLink active={!folder} onClick={() => navigate('')} path="">{rootName}</FolderLink>
                  </FolderDrop>
                  <FolderTree
                    folders={folders}
                    selected={folder}
                    onSelect={navigate}
                    canWrite={canWrite}
                    onDrop={onTreeDrop}
                    storageKey={`onyx.tree.open:${filespaceId || 'all'}`}
                  />
                </div>
              </Section>
            </div>
          </aside>

          <section className="files-pane" ref={paneRef}>
            {view === 'grid' && showTiles && subfolders.length > 0 && (
              <FolderTiles
                folders={subfolders}
                onOpen={navigate}
                canWrite={canWrite}
                onDrop={onTreeDrop}
              />
            )}
            {view === 'list' ? (
              <FileList
                {...gridProps}
                loading={loading}
                sort={sort}
                onSort={changeSort}
                columns={columns}
                picker={(waiting) => (
                  <ColumnPicker
                    available={available}
                    visible={columnKeys}
                    waiting={waiting}
                    onChange={changeColumns}
                    onReset={() => changeColumns(DEFAULT_COLUMNS)}
                    onAddField={isAdmin && flags.metadata ? () => setAddingField(true) : undefined}
                  />
                )}
                canEdit={canWrite}
                onEdit={editCell}
                suggestionsFor={suggestionsFor}
                onOpenFolder={navigate}
                usageRights={!!flags.usageRights}
                before={showTiles && subfolders.length > 0 ? (cols) => (
                  <FolderRows folders={subfolders} columns={cols} onOpen={navigate} canWrite={canWrite} onDrop={onTreeDrop} />
                ) : null}
              />
            ) : loading ? (
              <div className="empty">Loading…</div>
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
          {canForSome(selected, files, 'edit', { canWrite }) && <button className="btn" onClick={moveSelectedUI}>Move</button>}
          {canForSome(selected, files, 'delete', { canWrite }) && (
            <button className="btn btn-danger" onClick={trashSelected}>
              Remove
            </button>
          )}
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
            <span className="small muted">Files and folders go into {folder || rootName}</span>
          </div>
        </div>
      )}
      {marquee.box && (
        <div
          className="marquee"
          aria-hidden
          style={{
            left: marquee.box.left,
            top: marquee.box.top,
            width: marquee.box.right - marquee.box.left,
            height: marquee.box.bottom - marquee.box.top,
          }}
        />
      )}
      {confirmElement}
      {promptElement}
      {pickerElement}
      {contextMenuElement}
      {isAdmin && flags.metadata && (
        <NewFieldDialog open={addingField} onClose={() => setAddingField(false)} onCreate={createField} />
      )}
      <ShareDialog file={sharing} open={!!sharing} onClose={() => setSharing(null)} />
      {isAdmin && (
        <NewDriveDialog
          open={newDrive}
          onClose={() => setNewDrive(false)}
          onCreated={(d) => {
            setNewDrive(false);
            toast.success(`Made the drive “${d.name}”. Add its members from its menu.`);
            openDrive(d.id);
            router.refresh();
          }}
        />
      )}
      <DriveMembersDialog drive={membersOf} open={!!membersOf} onClose={() => setMembersOf(null)} />
      <InfoDialog
        info={info}
        schema={schema}
        onClose={() => setInfo(null)}
        onOpenFile={openFile}
        onDownload={downloadFile}
        onOpenFolder={navigate}
        onOpenDrive={openDrive}
        onDriveMembers={(d) => setMembersOf(d)}
      />
    </main>
  );
}

/**
 * The open folder as a path: every ancestor is a way back up, and a drop
 * target, so files can be dragged to a folder above without the tree. The
 * last crumb is the page's heading. Each crumb carries data-folder, so the
 * page's context menu treats it as that folder.
 */
function Breadcrumbs({ folder, rootName, onOpen, canWrite, onDrop }) {
  const crumbs = crumbsFor(folder, rootName);
  const here = crumbs[crumbs.length - 1];
  return (
    <nav className="crumbs" aria-label="Folder path">
      <ol>
        {crumbs.slice(0, -1).map((c) => (
          <li key={c.path || '/'} className="crumb-item">
            <FolderDrop target={c.path} enabled={canWrite} onDrop={onDrop} className="crumb-drop">
              <button type="button" className="crumb" data-folder={c.path} title={c.path || c.name} onClick={() => onOpen(c.path)}>
                {c.name}
              </button>
            </FolderDrop>
            <span className="crumb-sep" aria-hidden>/</span>
          </li>
        ))}
        <li className="crumb-item crumb-here">
          <h1 className="files-title truncate" aria-current="page" title={here.path || here.name}>{here.name}</h1>
        </li>
      </ol>
    </nav>
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
 * A folder has a size (its file count) and a type; the other columns are
 * about files and stay empty.
 */
function folderCell(f, c) {
  if (c.key === 'size') return f.count ? `${f.count} file${f.count === 1 ? '' : 's'}` : '—';
  if (c.key === 'type') return 'Folder';
  return '';
}

function FolderRows({ folders, columns, onOpen, canWrite, onDrop }) {
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
            {columns.map((c) => (
              <span key={c.key} className="filelist-cell muted truncate">{folderCell(f, c)}</span>
            ))}
            <span aria-hidden />
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
