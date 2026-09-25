'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { rectFrom, movedPast, edgeScroll } from '@/lib/marquee';

/**
 * Drag on empty space to draw a selection rectangle, as in Finder.
 *
 *   press on empty space, drag   selects what the rectangle touches
 *   with ⇧ or ⌘/Ctrl held        adds to what was already selected
 *   near the top or bottom edge  the page scrolls, and the rectangle with it
 *   Esc                          puts the selection back as it was
 *   press and let go, no drag    clears the selection (`onClear`)
 *
 * Mouse and pen only: on a touch screen a drag is a scroll.
 *
 * `canStart(event)` decides what counts as empty space — never a card, a
 * row, a folder or a control, which have presses of their own. `hitsIn(rect)`
 * returns the indices under a viewport rectangle (lib/marquee.js), and
 * `onSelect(indices, { base, additive })` applies them, `base` being what
 * `getSelection()` held when the drag began.
 *
 * The listeners go on window for the length of a drag rather than using
 * pointer capture, so the drag keeps going over anything, including outside
 * the page. The click that ends a drag is swallowed: it lands on whatever
 * was under the pointer, and a card would otherwise toggle itself.
 */
export default function useMarquee({ canStart, hitsIn, onSelect, onClear, getSelection }) {
  const [box, setBox] = useState(null);
  const live = useRef(null);
  live.current = { canStart, hitsIn, onSelect, onClear, getSelection };
  const drag = useRef(null);

  const update = useCallback(() => {
    const d = drag.current;
    if (!d?.active) return;
    const x = d.cx + window.scrollX;
    const y = d.cy + window.scrollY;
    const doc = rectFrom(d.x0, d.y0, x, y);
    const view = {
      left: doc.left - window.scrollX,
      top: doc.top - window.scrollY,
      right: doc.right - window.scrollX,
      bottom: doc.bottom - window.scrollY,
    };
    setBox(view);
    live.current.onSelect(live.current.hitsIn(view), { base: d.base, additive: d.additive });
  }, []);

  const end = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    cancelAnimationFrame(d.frame);
    window.removeEventListener('pointermove', d.onMove);
    window.removeEventListener('pointerup', d.onUp);
    window.removeEventListener('pointercancel', d.onCancel);
    window.removeEventListener('keydown', d.onKey, true);
    window.removeEventListener('scroll', d.onScroll);
    document.body.classList.remove('is-marqueeing');
    setBox(null);
  }, []);

  const onPointerDown = useCallback((e) => {
    if (e.button !== 0 || e.pointerType === 'touch' || drag.current) return;
    if (!live.current.canStart(e)) return;
    // No text selection from a press on empty space, and whatever had focus
    // (the search box, say) lets go of it, so ⌘A after a drag means files.
    e.preventDefault();
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const d = {
      x0: e.clientX + window.scrollX,
      y0: e.clientY + window.scrollY,
      cx: e.clientX,
      cy: e.clientY,
      active: false,
      additive,
      base: null,
      frame: 0,
      // A press that only closes an open menu is not a click on the page.
      menuOpen: !!document.querySelector('.ctx-menu, .menu'),
    };

    // Held near an edge, keep scrolling while the pointer stays put.
    const tick = () => {
      if (!drag.current?.active) return;
      const dy = edgeScroll(d.cy, window.innerHeight);
      if (dy) {
        window.scrollBy(0, dy);
        update();
      }
      d.frame = requestAnimationFrame(tick);
    };

    d.onMove = (ev) => {
      d.cx = ev.clientX;
      d.cy = ev.clientY;
      if (!d.active) {
        if (!movedPast(ev.clientX + window.scrollX - d.x0, ev.clientY + window.scrollY - d.y0)) return;
        d.active = true;
        d.base = new Set(live.current.getSelection?.() || []);
        document.body.classList.add('is-marqueeing');
        d.frame = requestAnimationFrame(tick);
      }
      update();
    };
    d.onUp = () => {
      if (d.active) {
        update();
        // The click this release makes would land on a card and toggle it.
        const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      } else if (!d.additive && !d.menuOpen) {
        live.current.onClear?.();
      }
      end();
    };
    d.onCancel = () => end();
    d.onKey = (ev) => {
      if (ev.key !== 'Escape' || !d.active) return;
      ev.preventDefault();
      ev.stopPropagation();
      live.current.onSelect([], { base: d.base, additive: true });
      end();
    };
    d.onScroll = () => update();

    drag.current = d;
    window.addEventListener('pointermove', d.onMove);
    window.addEventListener('pointerup', d.onUp);
    window.addEventListener('pointercancel', d.onCancel);
    window.addEventListener('keydown', d.onKey, true);
    window.addEventListener('scroll', d.onScroll, { passive: true });
  }, [update, end]);

  useEffect(() => end, [end]);

  return { onPointerDown, box };
}
