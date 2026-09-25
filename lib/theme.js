// lib/theme.js — the light / dark / system switch.
//
// The chosen preference ('light' | 'dark' | 'system') lives in localStorage;
// what the page actually wears is <html data-theme="light|dark">, which is
// the only thing CSS looks at. The colours themselves are custom properties
// (see brandDarkCssVars in lib/brand-config.js and the [data-theme='dark']
// block in globals.css), so a component that styles from var(--paper),
// var(--ink) and friends is themed without knowing a theme exists.
//
// Dependency-free: imported by the root layout (server) and ThemeToggle
// (client).

export const THEME_KEY = 'theme';
export const THEME_PREFS = ['light', 'dark', 'system'];

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Inlined in <head> by the root layout, so data-theme is set before the first
 * paint — a stylesheet or an effect would run after it, and a dark-mode user
 * would see a white flash on every load. It also follows the OS setting while
 * the preference is 'system', and other tabs when the preference changes.
 *
 * A string because it runs before any bundle has loaded. Keep it in step with
 * resolveTheme below. The try swallows a localStorage that throws (Safari
 * with storage blocked): the page then follows the OS, which is the default.
 */
export const THEME_SCRIPT = `(function(){try{var d=document.documentElement,m=matchMedia('${DARK_QUERY}');function a(){var p=null;try{p=localStorage.getItem('${THEME_KEY}')}catch(e){}d.dataset.theme=p==='light'||p==='dark'?p:m.matches?'dark':'light'}a();m.addEventListener('change',a);addEventListener('storage',function(e){if(e.key==='${THEME_KEY}')a()})}catch(e){}})()`;

/** The scheme a preference resolves to. Pure; mirrors THEME_SCRIPT. */
export function resolveTheme(pref, prefersDark) {
  return pref === 'light' || pref === 'dark' ? pref : prefersDark ? 'dark' : 'light';
}

/** The saved preference, or 'system'. Client only. */
export function readThemePref() {
  try {
    const p = localStorage.getItem(THEME_KEY);
    return THEME_PREFS.includes(p) ? p : 'system';
  } catch {
    return 'system';
  }
}

/** Save a preference and repaint now. Client only. */
export function setThemePref(pref) {
  try {
    if (pref === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    // Storage blocked: the choice still applies to this page view.
  }
  document.documentElement.dataset.theme = resolveTheme(pref, matchMedia(DARK_QUERY).matches);
}
