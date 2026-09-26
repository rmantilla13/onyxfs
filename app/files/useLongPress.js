'use client';

import { useEffect, useRef } from 'react';
import { fileKey, folderKey } from '@/lib/selection';

export const LONG_PRESS_MS = 450;
const SLOP_PX = 8;
// Android fires its own contextmenu on a long-press a little after ours.
const SWALLOW_MS = 800;
const ITEM = '[data-file-id], [data-folder]';

/**
 * A long-press on a file or folder in the pane, with a finger: it selects the
 * item and puts the page in selection mode, where taps toggle (a tap outside
 * it opens). Listened for once, on the element `ref` points at (the page's
 * <main>), for every item in `scope` — the sidebar's folders and the
 * breadcrumbs keep their taps.
 *
 * Three native gestures would otherwise collide with it, and each is handled:
 *   - the click that ends the press would toggle the item straight back:
 *     it is swallowed;
 *   - Android opens its context menu on the same press: a contextmenu that
 *     follows within a moment is cancelled (the selection bar's More has
 *     the same menu);
 *   - iOS lifts a draggable element into a native drag: the item is not
 *     draggable while a finger is on it.
 * The press is off after 8px of movement, a scroll, or the finger lifting.
 */
export default function useLongPress(ref, { onLongPress, scope = '.files-pane', delay = LONG_PRESS_MS } = {}) {
  const live = useRef(onLongPress);
  live.current = onLongPress;

  useEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    let press = null;

    const restore = () => {
      if (press?.item && press.draggable != null) press.item.setAttribute('draggable', press.draggable);
    };
    const cancel = () => {
      if (!press) return;
      clearTimeout(press.timer);
      restore();
      press = null;
      window.removeEventListener('scroll', cancel, true);
    };

    // After it fires: the click the finger makes when it lifts — however
    // long it is held — and Android's context menu, which comes while it is
    // still down.
    const swallowAfterFire = () => {
      const until = performance.now() + SWALLOW_MS;
      let lifted = null;
      const done = () => {
        clearTimeout(lifted);
        window.removeEventListener('click', click, true);
        window.removeEventListener('pointerup', up, true);
        window.removeEventListener('pointerdown', done, true);
      };
      const click = (ev) => { ev.stopPropagation(); ev.preventDefault(); done(); };
      const up = () => { clearTimeout(lifted); lifted = setTimeout(done, 400); };
      const menu = (ev) => {
        if (performance.now() > until) { window.removeEventListener('contextmenu', menu, true); return; }
        ev.preventDefault();
        ev.stopPropagation();
      };
      window.addEventListener('click', click, true);
      window.addEventListener('pointerup', up, true);
      // A new press means that one is over.
      setTimeout(() => window.addEventListener('pointerdown', done, true), 0);
      window.addEventListener('contextmenu', menu, true);
      setTimeout(() => window.removeEventListener('contextmenu', menu, true), SWALLOW_MS);
    };

    const onDown = (e) => {
      if (e.pointerType !== 'touch' || !e.isPrimary) return;
      cancel();
      const item = e.target?.closest?.(ITEM);
      if (!item || !item.closest(scope) || e.target.closest('input, textarea, select, button, a')) return;
      const draggable = item.getAttribute('draggable');
      if (draggable === 'true') item.setAttribute('draggable', 'false');
      press = {
        item, draggable, x: e.clientX, y: e.clientY,
        timer: setTimeout(() => {
          const p = press;
          if (!p) return;
          restore();
          press = null;
          window.removeEventListener('scroll', cancel, true);
          const id = p.item.getAttribute('data-file-id');
          const key = id != null ? fileKey(id) : folderKey(p.item.getAttribute('data-folder') || '');
          swallowAfterFire();
          try { navigator.vibrate?.(10); } catch {}
          live.current?.(key, p.item);
        }, delay),
      };
      window.addEventListener('scroll', cancel, true);
    };
    const onMove = (e) => {
      if (!press || e.pointerType !== 'touch') return;
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP_PX) cancel();
    };

    root.addEventListener('pointerdown', onDown, { passive: true });
    root.addEventListener('pointermove', onMove, { passive: true });
    root.addEventListener('pointerup', cancel, { passive: true });
    root.addEventListener('pointercancel', cancel, { passive: true });
    return () => {
      cancel();
      root.removeEventListener('pointerdown', onDown);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerup', cancel);
      root.removeEventListener('pointercancel', cancel);
    };
  }, [ref, scope, delay]);
}
