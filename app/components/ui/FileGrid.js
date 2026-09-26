'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import FileCard from './FileCard';
import { rowWindow } from '@/lib/virtual-rows';
import { gridHits, overlaps } from '@/lib/marquee';
import { rowsPerViewport } from '@/lib/nav-geometry';

/**
 * The library grid.
 *
 * A grid of a hundred thousand cards cannot put every card in the tab order —
 * tabbing past it would take a hundred thousand presses. The standard answer
 * is a roving tabindex: the grid is one tab stop, and the keyboard moves a
 * single focusable cell inside it. What each key does — arrows move the
 * selection with the focus, ⇧ extends it, Return and ⌘↓ open, Space looks —
 * is the page's (app/files/useSelectionModel.js, lib/nav-geometry.js), reached
 * through `handlers`; the grid tells it the columns it actually rendered
 * (`navRef`) and focuses the card it is sent to, scrolling it in first when
 * it is outside the rendered window.
 *
 * `role="listbox"` rather than `role="grid"`: grid requires row and gridcell
 * children, and the `repeat(auto-fill, …)` layout has no row elements to
 * hang them on. A listbox of options is what a selectable collection is.
 *
 * Virtualized: only the rows near the viewport are in the DOM. Infinite
 * scroll kept every loaded card mounted, so ten thousand rows in meant ten
 * thousand cards, 80k DOM nodes, and scrolling at a few frames a second. The
 * stylesheet still owns the layout; the column count and row height are read
 * back from it, and the page (not an inner box) remains the scroller.
 *
 * Cards are memoized (FileCard): a click, an arrow or a thumbnail arriving
 * re-renders the cards whose own props changed, not every mounted one.
 */
// Rows rendered above and below the viewport, so a fast flick does not show
// blank space before React catches up.
const OVERSCAN_ROWS = 4;
// Before the first measurement — the server render, and the client render
// that hydrates it — there is no layout to window against. Rather than one
// card in a box of no height, the first cards render in plain flow, enough
// to fill a large screen, so a folder's files are in the first paint. The
// layout effect then measures them and switches to the windowed layout
// before the browser paints again, and the two look the same.
const FIRST_PAINT_CARDS = 40;
// Cards on screen before anything else is: loaded at once, first.
const EAGER_CARDS = 8;

function FileGrid({
  files,
  selected,
  handlers,
  badgesFor,
  labelFor,
  emptyState,
  label = 'Files',
  onMissingThumb,
  pending = false,
  // Filled in with { hitsIn(rect) } for drag-to-select (useMarquee): which
  // cards a viewport rectangle touches, from the layout — cards scrolled out
  // of the window are not in the DOM to be asked.
  marqueeRef,
  // Filled in with { files: { cols, rowsPerPage, focus(i) } } for the keyboard.
  navRef,
}) {
  const outer = useRef(null);
  const ref = useRef(null);
  const pendingFocus = useRef(null);
  const [active, setActive] = useState(0);
  // Layout read back from the stylesheet: columns, row pitch (card + gap), the
  // grid's own bottom padding (the phone selection bar reserves some) and a
  // column's width, which is the `sizes` each card's srcset is chosen by.
  const [metrics, setMetrics] = useState({ cols: 1, pitch: 0, gap: 0, padBottom: 0, colW: 0 });
  const [range, setRange] = useState({ start: 0, end: 0 });
  const filesRef = useRef(files);
  filesRef.current = files;

  // Keep the roving index inside the list as it grows and shrinks. Without
  // this, filtering to fewer results leaves it pointing past the end and the
  // grid loses its tab stop entirely.
  useEffect(() => {
    setActive((i) => Math.min(Math.max(0, i), Math.max(0, files.length - 1)));
  }, [files.length]);

  // The column count is unknowable from `minmax(180px, 1fr)` — it depends on
  // the width the grid actually got. Read it back from layout.
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const style = window.getComputedStyle(el);
    const cols = Math.max(1, style.gridTemplateColumns.split(' ').filter(Boolean).length);
    const gap = parseFloat(style.rowGap) || 0;
    const colGap = parseFloat(style.columnGap) || gap;
    const padBottom = parseFloat(style.paddingBottom) || 0;
    const card = el.firstElementChild;
    // Before any card has rendered, estimate from the column width: a 4:3
    // thumbnail plus the two text lines under it.
    const width = el.clientWidth ? (el.clientWidth - colGap * (cols - 1)) / cols : 180;
    const height = card ? card.getBoundingClientRect().height : width * 0.75 + 58;
    const pitch = Math.max(1, height + gap);
    // The picture inside the card's 1px border.
    const colW = Math.max(0, Math.round(width - 2));
    setMetrics((m) => (m.cols === cols && Math.abs(m.pitch - pitch) < 0.5 && m.gap === gap && m.padBottom === padBottom && m.colW === colW
      ? m
      : { cols, pitch, gap, padBottom, colW }));
  }, []);

  const rowCount = Math.ceil(files.length / metrics.cols);

  // Which rows intersect the viewport, from the page scroll position.
  const updateRange = useCallback(() => {
    const el = outer.current;
    if (!el || !metrics.pitch) return;
    const { start, end } = rowWindow({
      top: el.getBoundingClientRect().top,
      viewport: window.innerHeight,
      pitch: metrics.pitch,
      rowCount,
      overscan: OVERSCAN_ROWS,
    });
    setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
  }, [metrics.pitch, rowCount]);

  useLayoutEffect(() => { measure(); }, [measure, files.length]);
  useLayoutEffect(() => { updateRange(); }, [updateRange]);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; updateRange(); });
    };
    const ro = new ResizeObserver(() => { measure(); onScroll(); });
    if (outer.current) ro.observe(outer.current);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [measure, updateRange]);

  const cellAt = (i) => {
    const f = filesRef.current[i];
    return f && ref.current ? ref.current.querySelector(`[data-file-id="${CSS.escape(String(f.id))}"]`) : null;
  };

  // A card that was out of the window when the keyboard moved to it is
  // focused once the render that brings it in has happened.
  useEffect(() => {
    const p = pendingFocus.current;
    if (p == null) return;
    const el = cellAt(p.i);
    if (!el) return;
    pendingFocus.current = null;
    el.focus({ preventScroll: true });
    // 'nearest', or every keypress yanks the page to centre the card.
    if (p.scroll) el.scrollIntoView({ block: 'nearest' });
  });

  const focusCell = useCallback((i, { scroll = true } = {}) => {
    const n = filesRef.current.length;
    if (!n) return;
    const next = Math.min(Math.max(0, i), n - 1);
    setActive(next);
    pendingFocus.current = { i: next, scroll };
    const el = cellAt(next);
    if (el) {
      pendingFocus.current = null;
      el.focus({ preventScroll: true });
      if (scroll) el.scrollIntoView({ block: 'nearest' });
    } else if (outer.current && metrics.pitch) {
      // Not rendered: scroll its row into view, and the effect above focuses
      // it after the next render.
      const row = Math.floor(next / metrics.cols);
      const top = outer.current.getBoundingClientRect().top + window.scrollY + row * metrics.pitch;
      const bottom = top + metrics.pitch - metrics.gap;
      if (top < window.scrollY + 64) window.scrollTo(0, Math.max(0, top - 64));
      else if (bottom > window.scrollY + window.innerHeight) window.scrollTo(0, bottom - window.innerHeight);
    }
  }, [metrics]);

  const revealCell = (i) => {
    const el = cellAt(i);
    if (el) { el.scrollIntoView({ block: 'nearest' }); return; }
    if (!outer.current || !metrics.pitch) return;
    const row = Math.floor(i / metrics.cols);
    const top = outer.current.getBoundingClientRect().top + window.scrollY + row * metrics.pitch;
    const bottom = top + metrics.pitch - metrics.gap;
    if (top < window.scrollY + 64) window.scrollTo(0, Math.max(0, top - 64));
    else if (bottom > window.scrollY + window.innerHeight) window.scrollTo(0, bottom - window.innerHeight);
  };

  if (navRef) {
    navRef.current.files = {
      cols: metrics.cols,
      rowsPerPage: rowsPerViewport(typeof window === 'undefined' ? 0 : window.innerHeight, metrics.pitch),
      focus: focusCell,
      // Bring the rendered window to the scroll position now, not on the
      // next scroll event (the page restoring a scroll position).
      update: updateRange,
      // Bring a card into view without moving the focus (Quick Look steps
      // behind its overlay, and closing lands on the card).
      reveal: (i) => revealCell(i),
    };
  }

  // The roving tab stop follows focus, however it got there — a click, the
  // keyboard, the page putting it back after Quick Look.
  const onFocus = (e) => {
    const id = e.target?.closest?.('[data-file-id]')?.getAttribute('data-file-id');
    if (id == null) return;
    const i = filesRef.current.findIndex((f) => String(f.id) === id);
    if (i >= 0) setActive((a) => (a === i ? a : i));
  };

  if (marqueeRef) {
    marqueeRef.current = {
      hitsIn: (rect) => {
        const el = outer.current;
        if (!el) return [];
        if (!metrics.pitch) {
          // Before the first measurement the cards are in plain flow: ask them.
          const out = [];
          filesRef.current.forEach((_, i) => { const c = i < FIRST_PAINT_CARDS ? cellAt(i) : null; if (c && overlaps(c.getBoundingClientRect(), rect)) out.push(i); });
          return out;
        }
        const b = el.getBoundingClientRect();
        return gridHits({
          rect,
          box: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
          cols: metrics.cols,
          pitch: metrics.pitch,
          gap: metrics.gap,
          count: filesRef.current.length,
        });
      },
    };
  }

  if (!files.length) return emptyState || null;

  const sizes = metrics.colW || undefined;
  const card = (f, i, tabbable) => (
    <FileCard
      key={f.id}
      file={f}
      labelFor={labelFor}
      badgesFor={badgesFor}
      selected={selected?.has(f.id) || false}
      tabIndex={i === tabbable ? 0 : -1}
      handlers={handlers}
      eager={i < EAGER_CARDS}
      sizes={sizes}
      onMissingThumb={onMissingThumb}
    />
  );

  const busy = pending ? { 'aria-busy': true } : {};
  if (!metrics.pitch) {
    return (
      <div ref={outer} className={pending ? 'is-pending' : undefined}>
        <div className="files-grid" role="listbox" aria-label={label} aria-multiselectable="true" ref={ref} onFocus={onFocus} {...busy}>
          {files.slice(0, FIRST_PAINT_CARDS).map((f, i) => card(f, i, active))}
        </div>
      </div>
    );
  }

  const first = range.start * metrics.cols;
  const last = Math.min(files.length, range.end * metrics.cols);
  // The roving tab stop has to be a mounted card, or tabbing skips the grid.
  const tabbable = active >= first && active < last ? active : first;
  const height = rowCount * metrics.pitch - metrics.gap + metrics.padBottom;

  return (
    <div ref={outer} className={pending ? 'is-pending' : undefined} style={{ position: 'relative', height: Math.max(height, 0) }}>
      <div
        className="files-grid"
        role="listbox"
        aria-label={label}
        aria-multiselectable="true"
        ref={ref}
        onFocus={onFocus}
        {...busy}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${range.start * metrics.pitch}px)` }}
      >
        {files.slice(first, Math.max(last, first + 1)).map((f, n) => card(f, first + n, tabbable))}
      </div>
    </div>
  );
}

export default memo(FileGrid);
