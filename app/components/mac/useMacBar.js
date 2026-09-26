'use client';

import { useEffect } from 'react';

// What in the bar takes a click. Everything else in it moves the window.
const CONTROLS = 'a[href], button, input, select, textarea, summary, [role="button"], [role="menu"], [role="dialog"], [data-no-drag]';

const rect = (r) => [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10) / 10);

/**
 * Inside Onyx for Mac the top bar is the window's title bar, and a web view
 * never moves its window — so this tells the app where the bar is and where
 * its controls are (window.onyxMac.setBar). Between the controls, a drag
 * moves the window and a double click zooms it, as on any title bar
 * (apple/OnyxMac/WindowChrome.swift).
 *
 * While a modal dialog is open the whole bar is the page's: its backdrop is
 * there, and a click on it closes the dialog.
 */
export default function useMacBar(ref) {
  useEffect(() => {
    const mac = typeof window !== 'undefined' ? window.onyxMac : null;
    const bar = ref.current;
    if (!mac?.setBar || !bar) return undefined;
    let timer = 0;
    let last = '';
    const measure = () => {
      timer = 0;
      const box = bar.getBoundingClientRect();
      const modal = document.querySelector('dialog[open]');
      const holes = modal
        ? [rect(box)]
        : [...bar.querySelectorAll(CONTROLS)]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0 && r.bottom > box.top && r.top < box.bottom)
          // A little slack, so a click at a control's edge is still a click.
          .map((r) => rect({ left: r.left - 2, top: r.top - 2, width: r.width + 4, height: r.height + 4 }));
      const next = JSON.stringify([rect(box), holes]);
      if (next === last) return;
      last = next;
      mac.setBar(rect(box), holes);
    };
    // A timer, not an animation frame: WebKit holds frames back while the
    // window is hidden (opened at login, behind another), and the bar must
    // be known by the time it shows.
    const later = () => { if (!timer) timer = setTimeout(measure, 16); };
    const sized = new ResizeObserver(later);
    sized.observe(bar);
    const changed = new MutationObserver(later);
    changed.observe(bar, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden', 'disabled', 'style'] });
    // Dialogs open anywhere on the page; only their `open` is watched.
    const dialogs = new MutationObserver(later);
    dialogs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
    window.addEventListener('resize', later);
    later();
    return () => {
      clearTimeout(timer);
      sized.disconnect();
      changed.disconnect();
      dialogs.disconnect();
      window.removeEventListener('resize', later);
      mac.setBar(null, []);
    };
  }, [ref]);
}
