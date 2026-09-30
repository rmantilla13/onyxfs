'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Thumb } from './FileCard';
import { FieldLine } from './FieldValue';
import { justifyRows, rowsInView, firstScreenTiles, tileHits, tileStep, aspectOf, MIN_ASPECT, MAX_ASPECT } from '@/lib/justify';
import { fileKey } from '@/lib/selection';
import { rowsPerViewport } from '@/lib/nav-geometry';

/**
 * The Tile layout: pictures in justified rows, each at its own aspect ratio
 * (lib/justify.js) — for photographs, which a grid of equal boxes crops.
 * The same collection as FileGrid with the same rules: a roving tab stop,
 * the page's selection model behind every press (`handlers`), windowed to
 * the rows near the viewport with the page as the scroller, and the layout
 * told to the keyboard (`navRef`, with `step` for ↑ ↓, since rows of
 * different widths are no grid) and to the marquee (`marqueeRef`).
 *
 * Before the width is known — the server render, and the render that
 * hydrates it — the first tiles sit in plain flow at the target height, so
 * the folder is in the first paint; the layout effect then measures and the
 * rows are justified before the next paint.
 */

// The height a row aims for, by the view's card size.
const TARGET = { s: 150, m: 210, l: 300 };
const GAP = 12;
// Under each picture: the name, and the fields' line when there are fields.
const CAPTION = { one: 32, two: 50 };
// Pixels drawn beyond the viewport each way, so a flick does not outrun it.
const OVERSCAN_PX = 900;
const FIRST_PAINT_TILES = 30;
// Tiles whose pictures are asked for at once, first: until the width is
// known, a phone's first screen; then every tile in the rows the top of the
// set shows on this screen (lib/justify.js firstScreenTiles).
const EAGER_TILES = 8;
// The top nav, which a tile scrolled up to must clear.
const NAV_CLEARANCE = 72;

/**
 * A tile's box is its picture's shape, so filling it shows the picture
 * whole — except one past the ratios a box may have (lib/justify.js), a
 * strip of a panorama, which is fitted inside its box instead.
 */
function tileFit(f) {
  const w = Number(f?.metadata?.width);
  const h = Number(f?.metadata?.height);
  if (!(w > 0 && h > 0)) return 'fill';
  const a = w / h;
  return a < MIN_ASPECT || a > MAX_ASPECT ? 'fit' : 'fill';
}

const Tile = memo(function Tile({ file: f, box, caption, selected, tabbable, handlers, labelFor, badgesFor, onMissingThumb, fields, rootName, eager, style }) {
  const key = fileKey(f.id);
  const drag = handlers?.dragStart;
  const badges = badgesFor?.(f) || null;
  return (
    <div
      role="option"
      aria-selected={selected}
      data-file-id={f.id}
      tabIndex={tabbable ? 0 : -1}
      className="tile"
      style={box ? { left: box.left, top: box.top, width: box.width } : style}
      onClick={handlers ? (e) => handlers.click(e, key) : undefined}
      onDoubleClick={handlers ? (e) => handlers.dblclick(e, key) : undefined}
      onKeyDown={handlers ? (e) => handlers.keyDown(e, key) : undefined}
      draggable={!!drag}
      onDragStart={drag ? (e) => drag(e, key) : undefined}
    >
      <div className="tile-pic" style={box ? { height: box.height } : undefined}>
        <Thumb file={f} label={labelFor?.(f)} onMissingThumb={onMissingThumb} sizes={box?.width} boxHeight={box?.height} eager={eager} fitMode={tileFit(f)} />
      </div>
      <div className="tile-caption" style={{ height: caption }}>
        <span className="tile-name truncate" title={f.name}>{f.name}</span>
        {(fields?.length > 0 || badges) && (
          <span className="tile-meta small muted">
            {fields?.length > 0 && <FieldLine file={f} fields={fields} rootName={rootName} className="field-line truncate" />}
            {badges && <span className="filecard-badges">{badges}</span>}
          </span>
        )}
      </div>
    </div>
  );
});

function TileGrid({
  files, selected, handlers, badgesFor, labelFor, emptyState, label = 'Files', onMissingThumb, pending = false,
  marqueeRef, navRef, fields, cardSize = 'm', rootName,
}) {
  const outer = useRef(null);
  const [width, setWidth] = useState(0);
  const [range, setRange] = useState({ start: 0, end: 0 });
  const [eagerCount, setEagerCount] = useState(0);
  const [active, setActive] = useState(0);
  const pendingFocus = useRef(null);
  const filesRef = useRef(files);
  filesRef.current = files;

  const caption = fields?.length ? CAPTION.two : CAPTION.one;
  // On a narrow screen a row aims lower, or a phone gets one picture a row.
  const target = Math.round(Math.min(TARGET[cardSize] || TARGET.m, Math.max(96, (width || 1200) * 0.44)));
  const aspects = useMemo(() => files.map(aspectOf), [files]);
  const layout = useMemo(
    () => (width ? justifyRows(aspects, { width, target, gap: GAP, caption }) : null),
    [aspects, width, target, caption],
  );
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  useEffect(() => {
    setActive((i) => Math.min(Math.max(0, i), Math.max(0, files.length - 1)));
  }, [files.length]);

  // The width, from the element itself; a callback ref, since it comes and
  // goes with the empty state (FileList explains the Strict Mode reason).
  const resize = useRef(null);
  const measureRef = useCallback((el) => {
    outer.current = el;
    resize.current?.disconnect();
    resize.current = null;
    if (!el) return;
    setWidth(el.clientWidth);
    resize.current = new ResizeObserver(() => setWidth(el.clientWidth));
    resize.current.observe(el);
  }, []);

  const updateRange = useCallback(() => {
    const el = outer.current;
    const L = layoutRef.current;
    if (!el || !L) return;
    const top = el.getBoundingClientRect().top;
    const r = rowsInView(L, -top - OVERSCAN_PX, -top + window.innerHeight + OVERSCAN_PX, { caption });
    setRange((prev) => (prev.start === r.start && prev.end === r.end ? prev : r));
    // From where the set starts on the page, so a scroll leaves it alone.
    const eager = firstScreenTiles(L, { top: top + window.scrollY, viewport: window.innerHeight, caption });
    setEagerCount((n) => (n === eager ? n : eager));
  }, [caption]);
  useLayoutEffect(() => { updateRange(); }, [updateRange, layout]);
  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; updateRange(); });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [updateRange]);

  const cellAt = (i) => {
    const f = filesRef.current[i];
    return f && outer.current ? outer.current.querySelector(`[data-file-id="${CSS.escape(String(f.id))}"]`) : null;
  };
  // Bring tile `i` into view when it is not drawn: its row, from the layout.
  const scrollToBox = (i) => {
    const b = layoutRef.current?.boxes[i];
    if (!b || !outer.current) return;
    const top = outer.current.getBoundingClientRect().top + window.scrollY + b.top;
    const bottom = top + b.height + caption;
    if (top < window.scrollY + NAV_CLEARANCE) window.scrollTo(0, Math.max(0, top - NAV_CLEARANCE));
    else if (bottom > window.scrollY + window.innerHeight) window.scrollTo(0, bottom - window.innerHeight + GAP);
  };

  useEffect(() => {
    const p = pendingFocus.current;
    if (p == null) return;
    const el = cellAt(p.i);
    if (!el) return;
    pendingFocus.current = null;
    el.focus({ preventScroll: true });
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
    } else if (scroll) {
      scrollToBox(next);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caption]);

  if (navRef) {
    const rows = layout?.rows || [];
    const pitch = rows.length ? (layout.height + GAP) / rows.length : target + caption + GAP;
    navRef.current.files = {
      // Crossing down from the folders lands by the first row's share of the
      // width, as a grid's first row would.
      cols: rows[0] ? rows[0].end - rows[0].start : 1,
      rowsPerPage: rowsPerViewport(typeof window === 'undefined' ? 0 : window.innerHeight, pitch),
      focus: focusCell,
      update: updateRange,
      reveal: (i) => { const el = cellAt(i); if (el) el.scrollIntoView({ block: 'nearest' }); else scrollToBox(i); },
      // ↑ ↓ between rows of different widths (lib/justify.js tileStep).
      step: (i, key) => tileStep(layoutRef.current, i, key, { width }),
    };
  }

  if (marqueeRef) {
    marqueeRef.current = {
      hitsIn: (rect) => {
        const el = outer.current;
        const L = layoutRef.current;
        if (!el || !L) return [];
        const b = el.getBoundingClientRect();
        return tileHits({ rect, box: { left: b.left, top: b.top, right: b.right, bottom: b.bottom }, layout: L, caption });
      },
    };
  }

  const onFocus = (e) => {
    const id = e.target?.closest?.('[data-file-id]')?.getAttribute('data-file-id');
    if (id == null) return;
    const i = filesRef.current.findIndex((f) => String(f.id) === id);
    if (i >= 0) setActive((a) => (a === i ? a : i));
  };

  if (!files.length) return emptyState || null;

  const common = { caption, handlers, labelFor, badgesFor, onMissingThumb, fields, rootName };
  const busy = pending ? { 'aria-busy': true } : {};

  if (!layout) {
    return (
      <div ref={measureRef} className={`tiles is-flow${pending ? ' is-pending' : ''}`} role="listbox" aria-label={label} aria-multiselectable="true" onFocus={onFocus} {...busy}>
        {files.slice(0, FIRST_PAINT_TILES).map((f, i) => (
          <Tile
            key={f.id}
            file={f}
            {...common}
            style={{ '--tile-h': `${target}px`, '--tile-a': aspects[i] }}
            selected={selected?.has(f.id) || false}
            tabbable={i === active}
            eager={i < (eagerCount || EAGER_TILES)}
          />
        ))}
      </div>
    );
  }

  const rows = layout.rows.slice(range.start, Math.max(range.end, range.start + 1));
  const first = rows[0]?.start ?? 0;
  const last = rows.length ? rows[rows.length - 1].end : 0;
  // The roving tab stop has to be a mounted tile, or tabbing skips the set.
  const tabbable = active >= first && active < last ? active : first;
  return (
    <div
      ref={measureRef}
      className={`tiles${pending ? ' is-pending' : ''}`}
      role="listbox"
      aria-label={label}
      aria-multiselectable="true"
      onFocus={onFocus}
      style={{ height: layout.height }}
      {...busy}
    >
      {rows.flatMap((row) => {
        const out = [];
        for (let i = row.start; i < row.end; i++) {
          const f = files[i];
          out.push(
            <Tile
              key={f.id}
              file={f}
              box={layout.boxes[i]}
              {...common}
              selected={selected?.has(f.id) || false}
              tabbable={i === tabbable}
              eager={i < (eagerCount || EAGER_TILES)}
            />,
          );
        }
        return out;
      })}
    </div>
  );
}

export default memo(TileGrid);
