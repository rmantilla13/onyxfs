'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import FilespaceSwitcher from '@/app/components/FilespaceSwitcher';
import ProfileMenu from '@/app/components/ProfileMenu';
import ShortcutsDialog from '@/app/components/ShortcutsDialog';
import { isTyping } from '@/lib/keys';

/**
 * The bar across the top: where you are (the filespace, switchable from any
 * page), the keyboard shortcuts, and the account menu — which holds Admin,
 * the theme, the build and signing out. Tabs for Files and Admin used to take
 * this space; the mark goes to the files, and Admin is one menu away for the
 * people who have it.
 *
 * `filespaces` comes from the page (listFilespacesForSpace). Switching goes
 * to /files with that filespace, so it works the same from a file's page or
 * from Admin as from the library itself.
 */
export default function TopNav({ brandName, markPath, email, isAdmin, build, filespaces = [] }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const [shortcuts, setShortcuts] = useState(false);

  // Only the library says which filespace is open; elsewhere the switcher is
  // a way in, not a claim about where the page is.
  const onFiles = pathname === '/files';
  const activeId = onFiles ? params.get('filespace') || '' : null;

  const switchTo = (id) => {
    if (onFiles && (id || '') === activeId) return;
    router.push(id ? `/files?filespace=${encodeURIComponent(id)}` : '/files');
  };

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
        <Link href="/files" className="topnav-brand">
          <img src={markPath} alt="" width={24} height={24} style={{ borderRadius: 6 }} />
          <strong className="topnav-name">{brandName}</strong>
        </Link>

        <FilespaceSwitcher
          compact
          filespaces={filespaces}
          activeId={activeId}
          isAdmin={isAdmin}
          onSwitch={switchTo}
        />

        <div className="spacer" />

        <button
          type="button"
          className="btn btn-ghost btn-sm topnav-shortcuts"
          onClick={() => setShortcuts(true)}
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
        >
          <svg viewBox="0 0 20 14" width="18" height="13" aria-hidden>
            <rect x="0.75" y="0.75" width="18.5" height="12.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path d="M4 4.5h1M7 4.5h1M10 4.5h1M13 4.5h1M16 4.5h0M4 7h1M7 7h1M10 7h1M13 7h1M6 9.75h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <span className="topnav-label">Shortcuts</span>
        </button>

        <ProfileMenu email={email} isAdmin={isAdmin} build={build} onShortcuts={() => setShortcuts(true)} />
      </div>
      <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />
    </header>
  );
}
