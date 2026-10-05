'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import ProfileMenu from '@/app/components/ProfileMenu';
import BrandLogo from '@/app/components/BrandLogo';
import ShortcutsDialog from '@/app/components/ShortcutsDialog';
import CommandPalette, { useCommandPaletteShortcut } from '@/app/components/CommandPalette';
import { isTyping, modKey } from '@/lib/keys';
import Icon from '@/app/components/ui/Icon';
import useMacApp from '@/app/components/useMacApp';
import useMacBar from '@/app/components/mac/useMacBar';
import FinderMenu from '@/app/components/mac/FinderMenu';

/**
 * The bar across the top: the mark, one search box, and the account menu.
 *
 * The search box is the command palette (⌘K), and the only one: on the
 * files page it filters the view on screen ("Filter this view by …"), and
 * everywhere it finds files across the whole library, folders, drives and
 * every action, including the keyboard shortcuts — which is why there is no
 * separate Shortcuts button, and why the drives are not repeated here (they
 * live in the files sidebar, and in the palette on every page). The files
 * toolbar's search chip reopens it with the search in it (`onyx:open-palette`).
 *
 * `filespaces` comes from the page (listFilespacesForSpace); the palette
 * lists them as drives.
 *
 * Inside Onyx for Mac this bar is the window's title bar — the app has no
 * toolbar of its own — so it also carries what the toolbar did: back and
 * forward beside the traffic lights, and the Finder menu. Its layout there
 * (clearing the traffic lights, the title bar's height) is CSS, keyed on
 * html[data-mac-app], which the app sets before the page paints.
 */
export default function TopNav({ brandName, logo, email, isAdmin, build, filespaces = [], library = null, avatarUrl = null }) {
  const [palette, setPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [shortcuts, setShortcuts] = useState(false);
  // The modifier is the platform's, which the server cannot know: render ⌘
  // and correct it after mount.
  const [mod, setMod] = useState('⌘');
  useEffect(() => { setMod(modKey()); }, []);

  // The Mac app's download, offered on a Mac browser — and never inside the
  // app itself, which says "OnyxMac" in its user agent. Decided after mount:
  // the server cannot see the platform, and guessing would flash on hydrate.
  const [offerMacApp, setOfferMacApp] = useState(false);
  const [inApp, setInApp] = useState(false);
  useEffect(() => {
    const ua = navigator.userAgent || '';
    const app = /OnyxMac\//.test(ua);
    setInApp(app);
    setOfferMacApp(!app && /Macintosh|Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua) && navigator.maxTouchPoints < 2);
  }, []);
  useCommandPaletteShortcut(setPalette);
  useEffect(() => {
    const onOpen = (e) => {
      setPaletteQuery(typeof e.detail?.query === 'string' ? e.detail.query : '');
      setPalette(true);
    };
    window.addEventListener('onyx:open-palette', onOpen);
    return () => window.removeEventListener('onyx:open-palette', onOpen);
  }, []);
  const closePalette = useCallback(() => { setPalette(false); setPaletteQuery(''); }, []);
  const mac = useMacApp();
  const bar = useRef(null);
  useMacBar(bar);

  // "?" anywhere that is not a text field or an open dialog.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.defaultPrevented || isTyping(e) || e.target?.closest?.('dialog')) return;
      e.preventDefault();
      setShortcuts(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className="topnav" ref={bar}>
      <div className="shell topnav-row">
        {mac.inApp && mac.hasBar && (
          <div className="topnav-history" role="group" aria-label="History">
            <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={mac.goBack} disabled={!mac.nav.canGoBack} aria-label="Back" title="Back (⌘[)">
              <Icon name="chevron-left" />
            </button>
            <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={mac.goForward} disabled={!mac.nav.canGoForward} aria-label="Forward" title="Forward (⌘])">
              <Icon name="chevron-right" />
            </button>
          </div>
        )}
        <Link href="/files" className="topnav-brand" title={library === false ? 'Files' : 'All files'}>
          <BrandLogo logo={logo} name={brandName} withName height={22} />
        </Link>

        <button type="button" className="topnav-search" onClick={() => setPalette(true)} aria-label="Search and commands" aria-keyshortcuts="Meta+K Control+K">
          <Icon name="search" size={15} />
          <span className="topnav-search-text">Search files, folders, drives…</span>
          <kbd className="topnav-search-kbd">{mod}K</kbd>
        </button>

        {offerMacApp && (
          <Link href="/download" className="btn btn-sm topnav-get-app" title="Download the Mac app">
            <Icon name="download" size={14} />
            Mac app
          </Link>
        )}
        {mac.inApp && mac.hasBar && <FinderMenu mac={mac} />}
        <ProfileMenu email={email} isAdmin={isAdmin} build={build} avatarUrl={avatarUrl} onShortcuts={() => setShortcuts(true)} inApp={inApp} />
      </div>
      <CommandPalette
        open={palette}
        onClose={closePalette}
        initialQuery={paletteQuery}
        drives={filespaces}
        library={library}
        isAdmin={isAdmin}
        onShortcuts={() => setShortcuts(true)}
      />
      <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />
    </header>
  );
}
