'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Menu, { MenuItem, MenuSeparator } from '@/app/components/ui/Menu';
import { THEME_KEY, readThemePref, setThemePref } from '@/lib/theme';
import { initialsFor } from '@/lib/account';

// ︎ asks for the text glyph, not the emoji, where a platform has both.
const THEMES = [
  { key: 'light', label: 'Light', icon: '☀︎' },
  { key: 'dark', label: 'Dark', icon: '☾︎' },
  { key: 'system', label: 'System', icon: '◐︎' },
];

/**
 * The account menu at the top right: who is signed in, Admin for admins, the
 * theme, the shortcuts, which build is serving the page, and signing out —
 * everything that was spread along the nav, in the one place people look for
 * it. Admin access is still decided on the server (ADMIN_EMAILS); this only
 * shows the way in.
 */
export default function ProfileMenu({ email, isAdmin = false, build, onShortcuts }) {
  // The server cannot see localStorage, so render 'system' and correct it
  // after mount rather than risk a hydration mismatch. The page is already in
  // the right scheme before this mounts (THEME_SCRIPT in the root layout).
  const [pref, setPref] = useState('system');
  useEffect(() => {
    setPref(readThemePref());
    // Another tab changed it: the inline script repaints, this keeps the ✓ honest.
    const onStorage = (e) => { if (e.key === THEME_KEY) setPref(readThemePref()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return (
    <Menu
      label="Account"
      trigger={(
        <>
          <span className="avatar" aria-hidden>{initialsFor(email)}</span>
          <span className="sr-only">Account menu for {email}</span>
          <span aria-hidden className="muted small">▾</span>
        </>
      )}
    >
      <div className="menu-heading">
        <span className="small muted">Signed in as</span>
        <span className="menu-heading-email" title={email}>{email}</span>
      </div>
      <MenuSeparator />
      {isAdmin && (
        <Link href="/admin" role="menuitem" className="menu-item">Admin</Link>
      )}
      {onShortcuts && (
        <MenuItem onClick={onShortcuts}>
          Keyboard shortcuts<span className="spacer" /><kbd>?</kbd>
        </MenuItem>
      )}
      <MenuSeparator />
      <div className="menu-label small muted">Theme</div>
      {THEMES.map((t) => (
        <button
          key={t.key}
          type="button"
          className="menu-item"
          role="menuitemradio"
          aria-checked={pref === t.key}
          onClick={() => { setThemePref(t.key); setPref(t.key); }}
        >
          <span aria-hidden style={{ width: 16, textAlign: 'center' }}>{t.icon}</span>
          {t.label}
          {pref === t.key && <><span className="spacer" /><span aria-hidden>✓</span></>}
        </button>
      ))}
      <MenuSeparator />
      <a href="/api/auth/signout" role="menuitem" className="menu-item">Sign out</a>
      {/* Which build is serving this page. The first question when something
          looks wrong in production is whether the fix is even live yet. */}
      {build && <div className="menu-foot mono" title={build.detail || build.label}>{build.label}</div>}
    </Menu>
  );
}
