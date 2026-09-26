'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fileKey, folderKey, parseKey, emptySelection, clickSelect, moveTo, toggleKey, splitKeys, joinKeys, sameMembers,
} from '@/lib/selection';
import { navTarget } from '@/lib/nav-geometry';
import usePointerIntent from './usePointerIntent';
import { MAX_TILES } from './FolderItems';

/**
 * The files pane's items — the folder tiles (or rows) and the files — as one
 * Finder-style selection:
 *
 *   click                    select the item alone
 *   ⌘/Ctrl-click             add or remove it
 *   ⇧-click                  the range from the anchor
 *   ⌘/Ctrl-⇧-click           add the range
 *   double-click, Return, ⌘↓ open (a file's page; a folder in place)
 *   Space                    Quick Look
 *   ⇧Space                   add or remove the focused item
 *   arrows, Home/End, PgUp/Dn move; the selection follows (⇧ extends)
 *
 * On a touch screen (usePointerIntent, per press) a tap opens; a long-press
 * (useLongPress) selects and enters selection mode, where taps toggle, until
 * the selection is empty again.
 *
 * FilesClient's `selected` (a Set of file ids) stays the source of truth for
 * files, so the bulk bar, the drag payload, ⌘I and the menus keep working on
 * it unchanged; folders are a second Set here. The rules themselves are pure
 * and tested (lib/selection.js, lib/nav-geometry.js). The item handlers are
 * one stable object, so memoized cards and rows are not re-rendered for them.
 *
 * `navRef.current` is filled in by the sections on screen (FileGrid or
 * FileList as `files`, FolderItems as `folders`) with their column count and
 * a way to focus an item, which is how an arrow crosses from the last row of
 * folders into the files and a card scrolled out of the window is reached.
 */
const NAV_KEYS = new Set(['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown']);
// A click this soon after a marquee ends is the release of that drag.
const AFTER_MARQUEE_MS = 300;

export default function useSelectionModel({
  selected, setSelected, files, folders = [], openFile, openFolder, onQuickLook, marqueeEndedAt,
}) {
  const isTouch = usePointerIntent();
  const [selectedFolders, setSelectedFolders] = useState(() => new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const anchor = useRef(null);
  const focus = useRef(null);
  const navRef = useRef({});

  const shownFolders = useMemo(() => folders.slice(0, MAX_TILES), [folders]);
  const order = useMemo(
    () => [...shownFolders.map((f) => folderKey(f.folder)), ...files.map((f) => fileKey(f.id))],
    [shownFolders, files],
  );
  const fileIndex = useMemo(() => new Map(files.map((f, i) => [String(f.id), i])), [files]);
  const folderIndex = useMemo(() => new Map(shownFolders.map((f, i) => [f.folder, i])), [shownFolders]);
  const keys = useMemo(() => joinKeys(selected, selectedFolders), [selected, selectedFolders]);

  // Folders that are no longer shown (another folder opened, a search) are
  // no longer selected.
  useEffect(() => {
    setSelectedFolders((prev) => {
      if (!prev.size) return prev;
      const next = new Set([...prev].filter((p) => folderIndex.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [folderIndex]);

  // Selection mode ends when nothing is left selected.
  useEffect(() => {
    if (!selected.size && !selectedFolders.size) setSelectionMode(false);
  }, [selected, selectedFolders]);

  // Everything the stable handlers read, current as of this render.
  const live = useRef(null);
  live.current = {
    selected, selectedFolders, keys, order, files, shownFolders, fileIndex, folderIndex, selectionMode,
    openFile, openFolder, onQuickLook, marqueeEndedAt,
  };

  const current = () => ({ keys: new Set(live.current.keys), anchor: anchor.current, focus: focus.current });

  const apply = useCallback((next) => {
    anchor.current = next.anchor ?? null;
    focus.current = next.focus ?? null;
    const { files: fset, folders: dset } = splitKeys(next.keys);
    setSelected((prev) => (sameMembers(prev, fset) ? prev : fset));
    setSelectedFolders((prev) => (sameMembers(prev, dset) ? prev : dset));
  }, [setSelected]);

  const posOf = (key) => {
    const p = parseKey(key);
    if (!p) return null;
    const L = live.current;
    if (p.type === 'folder') { const i = L.folderIndex.get(p.id); return i == null ? null : { s: 0, i }; }
    const i = L.fileIndex.get(p.id);
    return i == null ? null : { s: 1, i };
  };
  const keyAt = (pos) => {
    const L = live.current;
    if (!pos) return null;
    if (pos.s === 0) return L.shownFolders[pos.i] ? folderKey(L.shownFolders[pos.i].folder) : null;
    return L.files[pos.i] ? fileKey(L.files[pos.i].id) : null;
  };

  /** Put the keyboard on `key`: the section it is in focuses it (scrolling it in unless `scroll` is false). */
  const focusItem = useCallback((key, { scroll = true } = {}) => {
    const pos = posOf(key);
    if (!pos) return false;
    const nav = pos.s === 0 ? navRef.current.folders : navRef.current.files;
    if (!nav?.focus) return false;
    nav.focus(pos.i, { scroll });
    return true;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = useCallback((key) => {
    const p = parseKey(key);
    const L = live.current;
    if (!p) return;
    if (p.type === 'folder') { L.openFolder?.(p.id); return; }
    const f = L.files[L.fileIndex.get(p.id)];
    if (f) L.openFile?.(f);
  }, []);

  const move = useCallback((from, keyName, extend) => {
    const L = live.current;
    const sections = [
      { count: L.shownFolders.length, cols: navRef.current.folders?.cols || 1 },
      { count: L.files.length, cols: navRef.current.files?.cols || 1 },
    ];
    const rowsPerPage = navRef.current.files?.rowsPerPage || 1;
    const to = keyAt(navTarget(sections, posOf(from), keyName, { rowsPerPage }));
    if (!to) return false;
    apply(moveTo(current(), to, { extend, order: L.order }));
    focusItem(to);
    return true;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apply, focusItem]);

  const keyDown = useCallback((e, key) => {
    if (e.defaultPrevented || e.altKey) return;
    if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
    const mod = e.metaKey || e.ctrlKey;
    // ⌘↓ opens, as in Finder (Ctrl+↓ elsewhere). Every other chord — ⌘↑,
    // ⌘A, ⌘I — is the page's.
    if (mod && e.key === 'ArrowDown') { e.preventDefault(); open(key); return; }
    if (mod) return;
    if (e.key === 'Enter') { e.preventDefault(); open(key); return; }
    if (e.key === ' ' || e.key === 'Spacebar') {
      // A div is not a button: Space has to be handled, or it scrolls.
      e.preventDefault();
      if (e.shiftKey) apply(toggleKey(current(), key));
      else live.current.onQuickLook?.(key);
      return;
    }
    if (NAV_KEYS.has(e.key)) {
      e.preventDefault();
      move(key, e.key, e.shiftKey);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apply, move, open]);

  const click = useCallback((e, key) => {
    if (e.defaultPrevented) return;
    // The second click of a double-click: that opens (dblclick), and the
    // first already selected.
    if (e.detail > 1) return;
    const L = live.current;
    if (performance.now() - (L.marqueeEndedAt?.() ?? -Infinity) < AFTER_MARQUEE_MS) return;
    if (isTouch()) {
      if (L.selectionMode) apply(clickSelect(current(), key, { toggle: true, order: L.order }));
      else open(key);
      return;
    }
    apply(clickSelect(current(), key, { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey, order: L.order }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apply, open, isTouch]);

  const dblclick = useCallback((e, key) => {
    // A tap already opened it.
    if (isTouch()) return;
    open(key);
  }, [open, isTouch]);

  const handlers = useMemo(() => ({ click, dblclick, keyDown }), [click, dblclick, keyDown]);

  /** Replace the selection with `list` (keys). */
  const setKeys = useCallback((list, { anchor: a, focus: f } = {}) => {
    const arr = [...(list || [])];
    apply({ keys: new Set(arr), anchor: a ?? anchor.current ?? arr[0] ?? null, focus: f ?? arr[arr.length - 1] ?? focus.current });
  }, [apply]);

  const clear = useCallback(() => {
    apply(emptySelection());
    setSelectionMode(false);
  }, [apply]);

  /**
   * A right-click (or a drag) on `key`: an item outside the selection is
   * selected on its own first, so the menu acts on what is highlighted; one
   * inside it keeps the selection. Returns the keys the action is for.
   */
  const ensureSelected = useCallback((key) => {
    const L = live.current;
    if (L.keys.has(key)) return new Set(L.keys);
    apply(clickSelect(current(), key, { order: L.order }));
    return new Set([key]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apply]);

  /** A long-press: the item flips and taps toggle from now on. */
  const longPress = useCallback((key) => {
    apply(clickSelect(current(), key, { toggle: true, order: live.current.order }));
    setSelectionMode(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apply]);

  /**
   * A key pressed with the focus on the page rather than an item (after a
   * marquee, or a click on empty space): the keyboard picks up at the
   * selection's focus — or the first item — as if it had been there.
   */
  const bodyKey = useCallback((e) => {
    const L = live.current;
    if (!L.order.length) return false;
    const mod = e.metaKey || e.ctrlKey;
    const opening = e.key === 'Enter' || (mod && e.key === 'ArrowDown') || e.key === ' ';
    if (!NAV_KEYS.has(e.key) && !opening) return false;
    if (mod && e.key !== 'ArrowDown') return false;
    const at = [focus.current, ...L.order.filter((k) => L.keys.has(k))].find((k) => k && posOf(k));
    if (!at) {
      if (opening || !NAV_KEYS.has(e.key)) return false;
      e.preventDefault();
      const first = e.key === 'End' ? L.order[L.order.length - 1] : L.order[0];
      apply({ keys: new Set([first]), anchor: first, focus: first });
      focusItem(first);
      return true;
    }
    focusItem(at, { scroll: false });
    keyDown(e, at);
    return true;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apply, focusItem, keyDown]);

  return {
    navRef,
    handlers,
    order,
    keys,
    selectedFolders,
    selectionMode,
    setSelectionMode,
    focusKey: () => focus.current,
    isSelected: (key) => keys.has(key),
    setKeys,
    clear,
    ensureSelected,
    longPress,
    focusItem,
    open,
    move,
    bodyKey,
  };
}
