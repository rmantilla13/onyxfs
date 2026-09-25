'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import FileCard from './FileCard';
import { rowWindow } from '@/lib/virtual-rows';
import { gridHits, overlaps } from '@/lib/marquee';

/**
 * The library grid, with the keyboard behaviour the old one had none of.
 *
 * A grid of a hundred thousand cards cannot put every card in the tab order —
 * tabbing past it would take a hundred thousand presses. The standard answer
 * is a roving tabindex: the grid is one tab stop, and arrow keys move a
 * single focusable cell inside it.
 *
 *   ← →      previous / next
 *   ↑ ↓      up / down a row, by the column count actually rendered
 *   Home End first / last
 *   Space    select
 *   Enter    open
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

export default function FileGrid({
  files,
  selected,
  onSelect,
  onOpen,
  badgesFor,
  labelFor,
  emptyState,
  label = 'Files',
  onMissingThumb,
  onDragFile,
  // Filled in with { hitsIn(rect) } for drag-to-select (useMarquee): which
  // cards a viewport rectangle touches, from the layout — cards scrolled out
  // of the window are not in the DOM to be asked.
  marqueeRef,
}) {
  const outer = useRef(null);
  const ref = useRef(null);
  const cells = useRef([]);
  const pendingFocus = useRef(null);
  const [active, setActive] = useState(0);
  // Layout read back from the stylesheet: columns, row pitch (card + gap), and
  // the grid's own bottom padding (the phone selection bar reserves some).
  const [metrics, setMetrics] = useState({ cols: 1, pitch: 0, gap: 0, padBottom: 0 });
  const [range, setRange] = useState({ start: 0, end: 0 });

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
    const padBottom = parseFloat(style.paddingBottom) || 0;
    const card = el.firstElementChild;
    // Before any card has rendered, estimate from the column width: a 4:3
    // thumbnail plus the two text lines under it.
    const width = el.clientWidth ? (el.clientWidth - gap * (cols - 1)) / cols : 180;
    const height = card ? card.getBoundingClientRect().height : width * 0.75 + 58;
    const pitch = Math.max(1, height + gap);
    setMetrics((m) => (m.cols === cols && Math.abs(m.pitch - pitch) < 0.5 && m.gap === gap && m.padBottom === padBottom
      ? m
      : { cols, pitch, gap, padBottom }));
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

  // A card that was out of the window when the keyboard moved to it is
  // focused once the render that brings it in has happened.
  useEffect(() => {
    const i = pendingFocus.current;
    if (i == null) return;
    const el = cells.current[i];
    if (!el) return;
    pendingFocus.current = null;
    el.focus({ preventScroll: true });
    // 'nearest', or every keypress yanks the page to centre the card.
    el.scrollIntoView({ block: 'nearest' });
  });

  const focusCell = useCallback((i) => {
    const next = Math.min(Math.max(0, i), files.length - 1);
    setActive(next);
    pendingFocus.current = next;
    const el = cells.current[next];
    if (el) {
      pendingFocus.current = null;
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'nearest' });
    } else if (outer.current && metrics.pitch) {
      // Not rendered: scroll its row into view, and the effect above focuses
      // it after the next render.
      const row = Math.floor(next / metrics.cols);
      const top = outer.current.getBoundingClientRect().top + window.scrollY + row * metrics.pitch;
      const bottom = top + metrics.pitch - metrics.gap;
      if (top < window.scrollY) window.scrollTo(0, top);
      else if (bottom > window.scrollY + window.innerHeight) window.scrollTo(0, bottom - window.innerHeight);
    }
  }, [files.length, metrics]);

  const onKeyDown = useCallback((e, index) => {
    // Never swallow a key meant for a text field inside a card.
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    // Nor a shortcut: ⌘↑ is "up to the enclosing folder" (see FilesClient).
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const cols = metrics.cols;
    const moves = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      ArrowDown: index + cols,
      ArrowUp: index - cols,
      Home: 0,
      End: files.length - 1,
    };
    if (e.key in moves) {
      e.preventDefault();
      focusCell(moves[e.key]);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpen?.(files[index]);
      return;
    }
    // A div is not a button, so Space has to be handled — and prevented, or
    // it scrolls the page under the grid.
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      onSelect?.(files[index]);
    }
  }, [metrics.cols, files, focusCell, onOpen, onSelect]);

  if (marqueeRef) {
    marqueeRef.current = {
      hitsIn: (rect) => {
        const el = outer.current;
        if (!el) return [];
        if (!metrics.pitch) {
          // Before the first measurement the cards are in plain flow: ask them.
          const out = [];
          cells.current.forEach((c, i) => { if (c && i < files.length && overlaps(c.getBoundingClientRect(), rect)) out.push(i); });
          return out;
        }
        const b = el.getBoundingClientRect();
        return gridHits({
          rect,
          box: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
          cols: metrics.cols,
          pitch: metrics.pitch,
          gap: metrics.gap,
          count: files.length,
        });
      },
    };
  }

  if (!files.length) return emptyState || null;

  const card = (f, i, tabbable) => (
    <FileCard
      key={f.id}
      file={f}
      label={labelFor?.(f)}
      badges={badgesFor?.(f)}
      selected={selected?.has(f.id) || false}
      tabIndex={i === tabbable ? 0 : -1}
      innerRef={(el) => { cells.current[i] = el; }}
      onKeyDown={(e) => onKeyDown(e, i)}
      onSelect={() => { setActive(i); onSelect?.(f); }}
      onOpen={() => onOpen?.(f)}
      onDragStart={onDragFile ? (e) => onDragFile(f, e) : undefined}
      onMissingThumb={onMissingThumb}
    />
  );

  if (!metrics.pitch) {
    return (
      <div ref={outer}>
        <div className="files-grid" role="listbox" aria-label={label} aria-multiselectable="true" ref={ref}>
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
    <div ref={outer} style={{ position: 'relative', height: Math.max(height, 0) }}>
      <div
        className="files-grid"
        role="listbox"
        aria-label={label}
        aria-multiselectable="true"
        ref={ref}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${range.start * metrics.pitch}px)` }}
      >
        {files.slice(first, Math.max(last, first + 1)).map((f, n) => card(f, first + n, tabbable))}
      </div>
    </div>
  );
}
