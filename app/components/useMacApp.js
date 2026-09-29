'use client';

import { useEffect, useState } from 'react';
import { samePinnedFolders, sameSet } from '@/lib/offline-marks';

/**
 * The Mac app's bridge, when this page is running inside it.
 *
 * Onyx for Mac shows the web workspace in a window of its own and defines
 * `window.onyxMac` before the page runs (apple/OnyxMac/WebController.swift):
 * keeping files offline on the Mac, and putting drives in Finder. In a
 * browser there is no such object and this returns `inApp: false`, so the
 * menus offer none of it.
 *
 * `pinned` holds the ids of files kept offline (directly, or through a
 * pinned folder or drive); `pinnedFolders` the folders and whole drives kept,
 * as { scope, path } — lib/offline-marks.js turns the two into the marks the
 * page shows; `mounted` the drives in Finder, as the app names
 * them ("drive.<id>", "library"). `nav` is the window's back and forward;
 * `finder` the drives Finder can show, with how each mount is doing (the
 * bar's Finder menu); `transcriber` is { enabled, busy } — busy is the id of
 * the file this Mac is transcribing. Each is empty (or null) in an app older
 * than it is.
 */
const NONE = { inApp: false, pinned: new Set(), mounted: new Set(), pinnedFolders: [], nav: { canGoBack: false, canGoForward: false }, finder: { drives: [], states: {}, busy: [] }, transcriber: null };

/** `prev` when it says the same as `next`, else `next`. */
const keep = (prev, next, same) => (same(prev, next) ? prev : next);

export default function useMacApp() {
  const [state, setState] = useState(NONE);

  useEffect(() => {
    const mac = typeof window !== 'undefined' ? window.onyxMac : null;
    if (!mac) return undefined;
    // The app says everything each time anything changes — a mount, a page
    // back — so what did not change keeps its identity: every card's offline
    // mark hangs off `pinned`, and a new Set of the same ids would redraw them all.
    const apply = (s) => setState((prev) => ({
      inApp: true,
      pinned: keep(prev.pinned, new Set(s?.pinned || []), sameSet),
      mounted: keep(prev.mounted, new Set(s?.mounted || []), sameSet),
      pinnedFolders: keep(prev.pinnedFolders, Array.isArray(s?.pinnedFolders) ? s.pinnedFolders : [], samePinnedFolders),
      nav: { ...NONE.nav, ...(s?.nav || {}) },
      finder: {
        drives: Array.isArray(s?.finder?.drives) ? s.finder.drives : [],
        states: s?.finder?.states || {},
        busy: Array.isArray(s?.finder?.busy) ? s.finder.busy : [],
      },
      transcriber: s?.transcriber && typeof s.transcriber === 'object'
        ? { enabled: s.transcriber.enabled !== false, busy: s.transcriber.busy || null }
        : null,
    }));
    apply(mac.state);
    const on = (e) => apply(e.detail);
    window.addEventListener('onyxmac:state', on);
    return () => window.removeEventListener('onyxmac:state', on);
  }, []);

  const mac = () => (typeof window !== 'undefined' ? window.onyxMac : null);
  return {
    ...state,
    /** The app's name for a drive: "drive.<id>", or "library" for files in no drive. */
    scopeOf: (driveId) => (driveId ? `drive.${driveId}` : 'library'),
    pinFiles: (ids, driveId) => mac()?.pinFiles(ids, driveId || null),
    unpinFiles: (ids, driveId) => mac()?.unpinFiles(ids, driveId || null),
    pinFolder: (path, driveId, on = true) => mac()?.pinFolder(path, driveId || null, on),
    showInFinder: (driveId, name) => mac()?.showInFinder(driveId || null, name || ''),
    /** Newer apps only: each is undefined in one that predates the bar. */
    setMounted: (driveId, on, name) => mac()?.setMounted?.(driveId || null, on, name || ''),
    reveal: (driveId) => mac()?.reveal?.(driveId || null),
    syncNow: () => mac()?.syncNow?.(),
    goBack: () => mac()?.goBack?.(),
    goForward: () => mac()?.goForward?.(),
    hasBar: typeof window !== 'undefined' && !!window.onyxMac?.setBar,
    /** Look at the transcription queue now, not at the next poll. A no-op in builds without it. */
    transcribe: (fileId) => mac()?.transcribe?.(fileId),
    folderPinned: (path, driveId) => state.pinnedFolders.some((f) =>
      f.scope === (driveId ? `drive.${driveId}` : 'library') && f.path === path),
  };
}
