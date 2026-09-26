'use client';

import { useCallback, useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Drawer from './Drawer';

// The drawer address last opened over its list by a navigation in this tab
// (useDrawerReturn notes it). Module state is per tab, which is the scope
// that matters: it says the history entry before the drawer is the list.
let openedFromList = null;

const decode = (p) => { try { return decodeURIComponent(p); } catch { return p; } };

/**
 * A Drawer that is a page: it is open because its route is, and closing it
 * is going back to the list at `back`. Used by the drawer routes and their
 * loading and error states, which are server files and cannot hand a
 * function to Drawer themselves.
 *
 * Closing goes back in history when the drawer was opened from the list in
 * this tab, so the browser's Back after a close leaves the list instead of
 * opening the drawer again; otherwise (a link from elsewhere, a reload) it
 * replaces the drawer's entry with the list, adding none.
 */
export default function RouteDrawer({ back, children, ...props }) {
  const close = useCloseDrawer(back);
  return <Drawer {...props} onClose={close}>{children}</Drawer>;
}

/** Close the drawer this is rendered in (see RouteDrawer), at most once. */
export function useCloseDrawer(back) {
  const router = useRouter();
  const pathname = usePathname();
  const closing = useRef(false);
  useEffect(() => { closing.current = false; }, [pathname]);
  return useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    if (openedFromList && decode(openedFromList) === decode(pathname)) {
      openedFromList = null;
      router.back();
    } else {
      router.replace(back, { scroll: false });
    }
  }, [router, pathname, back]);
}

/**
 * For the list a drawer opens over (Admin → Drives): notes a drawer opened
 * from it, for useCloseDrawer, and when the drawer closes — by Close,
 * Escape or the browser's Back — puts the keyboard back on the row that
 * was open, so a keyboard user carries on from where they were rather than
 * from the top of the page. Only when focus would otherwise be lost: a
 * dialog that handed focus back itself (ui/Dialog) is left alone.
 */
export function useDrawerReturn(listPath) {
  const pathname = usePathname();
  const prev = useRef(pathname);
  useEffect(() => {
    const was = prev.current;
    prev.current = pathname;
    const isDrawer = (p) => !!p && p.startsWith(`${listPath}/`);
    if (isDrawer(pathname)) {
      // Opened from the list: the entry before it is the list. Arrived at
      // any other way (the list mounts with the drawer already open), it
      // may not be, so nothing is assumed.
      openedFromList = was === listPath ? pathname : null;
      return undefined;
    }
    if (pathname !== listPath || !isDrawer(was)) return undefined;
    if (openedFromList && decode(openedFromList) === decode(was)) openedFromList = null;
    const frame = requestAnimationFrame(() => {
      const now = document.activeElement;
      if (now && now !== document.body) return;
      const row = [...document.querySelectorAll('#admin-main .dt-primary a[href]')]
        .find((a) => decode(a.getAttribute('href')) === decode(was));
      row?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname, listPath]);
}
