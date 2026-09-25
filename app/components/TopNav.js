'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import ProfileMenu from '@/app/components/ProfileMenu';
import BrandLogo from '@/app/components/BrandLogo';
import ShortcutsDialog from '@/app/components/ShortcutsDialog';
import CommandPalette, { useCommandPaletteShortcut } from '@/app/components/CommandPalette';
import { isTyping, modKey } from '@/lib/keys';

/**
 * The bar across the top: the mark, one search box, and the account menu.
 *
 * The search box is the command palette (⌘K): files across the whole
 * library, folders, drives and every action, including the keyboard
 * shortcuts — which is why there is no separate Shortcuts button, and why
 * the drives are not repeated here (they live in the files sidebar, and in
 * the palette on every page).
 *
 * `filespaces` comes from the page (listFilespacesForSpace); the palette
 * lists them as drives.
 */
export default function TopNav({ brandName, logo, email, isAdmin, build, filespaces = [], avatarUrl = null }) {
  const [palette, setPalette] = useState(false);
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
    <header className="topnav">
      <div className="shell topnav-row">
        <Link href="/files" className="topnav-brand" title="All files">
          <BrandLogo logo={logo} name={brandName} withName height={22} />
        </Link>

        <button type="button" className="topnav-search" onClick={() => setPalette(true)} aria-label="Search and commands" aria-keyshortcuts="Meta+K Control+K">
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
            <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span className="topnav-search-text">Search files, folders, drives…</span>
          <kbd className="topnav-search-kbd">{mod}K</kbd>
        </button>

        {offerMacApp && (
          <Link href="/download" className="btn btn-sm topnav-get-app" title="Download the Mac app">
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
            </svg>
            Mac app
          </Link>
        )}
        <ProfileMenu email={email} isAdmin={isAdmin} build={build} avatarUrl={avatarUrl} onShortcuts={() => setShortcuts(true)} inApp={inApp} />
      </div>
      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        drives={filespaces}
        isAdmin={isAdmin}
        onShortcuts={() => setShortcuts(true)}
      />
      <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />
    </header>
  );
}
