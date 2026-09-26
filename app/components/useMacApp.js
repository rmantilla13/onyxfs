'use client';

import { useEffect, useState } from 'react';

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
 * pinned folder or drive); `mounted` the drives in Finder, as the app names
 * them ("drive.<id>", "library"). `nav` is the window's back and forward;
 * `finder` the drives Finder can show, with how each mount is doing (the
 * bar's Finder menu). All three are empty in an app older than they are.
 */
const NONE = { inApp: false, pinned: new Set(), mounted: new Set(), pinnedFolders: [], nav: { canGoBack: false, canGoForward: false }, finder: { drives: [], states: {}, busy: [] } };

export default function useMacApp() {
  const [state, setState] = useState(NONE);

  useEffect(() => {
    const mac = typeof window !== 'undefined' ? window.onyxMac : null;
    if (!mac) return undefined;
    const apply = (s) => setState({
      inApp: true,
      pinned: new Set(s?.pinned || []),
      mounted: new Set(s?.mounted || []),
      pinnedFolders: Array.isArray(s?.pinnedFolders) ? s.pinnedFolders : [],
      nav: { ...NONE.nav, ...(s?.nav || {}) },
      finder: {
        drives: Array.isArray(s?.finder?.drives) ? s.finder.drives : [],
        states: s?.finder?.states || {},
        busy: Array.isArray(s?.finder?.busy) ? s.finder.busy : [],
      },
    });
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
    folderPinned: (path, driveId) => state.pinnedFolders.some((f) =>
      f.scope === (driveId ? `drive.${driveId}` : 'library') && f.path === path),
  };
}
