'use client';

import { useEffect, useState } from 'react';
import Menu from '@/app/components/ui/Menu';
import { THEME_KEY, readThemePref, setThemePref } from '@/lib/theme';

// \uFE0E asks for the text glyph, not the emoji, where a platform has both.
const OPTIONS = [
  { key: 'light', label: 'Light', icon: '☀\uFE0E' },
  { key: 'dark', label: 'Dark', icon: '☾\uFE0E' },
  { key: 'system', label: 'System', icon: '◐\uFE0E' },
];

/**
 * Light / Dark / System. The page is already wearing the right scheme before
 * this mounts (THEME_SCRIPT in the root layout); this only changes it.
 */
export default function ThemeToggle() {
  // The server cannot see localStorage, so render 'system' and correct it
  // after mount rather than risk a hydration mismatch.
  const [pref, setPref] = useState('system');
  useEffect(() => {
    setPref(readThemePref());
    // Another tab changed it: the inline script repaints, this keeps the ✓ honest.
    const onStorage = (e) => { if (e.key === THEME_KEY) setPref(readThemePref()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const current = OPTIONS.find((o) => o.key === pref);
  return (
    <Menu
      trigger={<><span aria-hidden>{current.icon}</span><span className="sr-only">Theme: {current.label}</span></>}
    >
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          className="menu-item"
          role="menuitemradio"
          aria-checked={pref === o.key}
          onClick={() => { setThemePref(o.key); setPref(o.key); }}
        >
          <span aria-hidden style={{ width: 16, textAlign: 'center' }}>{o.icon}</span>
          {o.label}
          {pref === o.key && <><span className="spacer" /><span aria-hidden>✓</span></>}
        </button>
      ))}
    </Menu>
  );
}
