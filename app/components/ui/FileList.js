'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Thumb, fmtSize } from './FileCard';
import { rowWindow } from '@/lib/virtual-rows';
import { LIST_COLUMNS, columnOf, nextSortFor } from '@/lib/list-columns';

/**
 * The library as a list: one row per file, with sortable Name, Size, Type
 * and Modified columns. The same collection as FileGrid with the same rules,
 * so the two stay interchangeable:
 *
 *   click      select (toggles, so several can be picked)
 *   dbl-click  open
 *   ↑ ↓        previous / next row
 *   Home End   first / last
 *   Space      select
 *   Enter      open
 *
 * Rows carry data-file-id, so the page's context menu and drag-to-folder
 * work on them exactly as on cards.
 *
 * Virtualized the way the grid is: the page is the scroller, only the rows
 * near the viewport are mounted, and the row height is read back from the
 * stylesheet rather than assumed.
 *
 * Sorting is the server's (see lib/list-columns.js); a header click asks the
 * page for a new sort and the listing reloads in that order.
 *
 * `before` renders between the header and the files — the page puts the open
 * folder's subfolders there.
 */
const OVERSCAN_ROWS = 8;

const dateFmt = typeof Intl !== 'undefined'
  ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
  : null;
const timeFmt = typeof Intl !== 'undefined'
  ? new Intl.DateTimeFormat(undefined, { timeStyle: 'short' })
  : null;

function Modified({ at }) {
  if (!at || !dateFmt) return <span className="muted">—</span>;
  const d = new Date(Number(at));
  return (
    <time dateTime={d.toISOString()} title={d.toLocaleString()}>
      {dateFmt.format(d)}<span className="filelist-time"> {timeFmt.format(d)}</span>
    </time>
  );
}

export function FileListHeader({ sort, onSort }) {
  const active = columnOf(sort);
  return (
    <div className="filelist-head filelist-cols">
      <span aria-hidden />
      {LIST_COLUMNS.map((c) => {
        const on = active?.key === c.key;
        const dir = on ? active.dir : null;
        const next = nextSortFor(c.key, sort) === c.asc ? 'ascending' : 'descending';
        return (
          <button
            key={c.key}
            type="button"
            className={`filelist-sort filelist-col-${c.key}${on ? ' active' : ''}`}
            aria-pressed={on}
            aria-label={`${c.label}${on ? `, sorted ${dir === 'asc' ? 'ascending' : 'descending'}` : ''}. Sort ${next}.`}
            onClick={() => onSort?.(nextSortFor(c.key, sort))}
          >
            <span>{c.label}</span>
            <span className="filelist-arrow" aria-hidden>{on ? (dir === 'asc' ? '↑' : '↓') : ''}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function FileList({
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
  sort,
  onSort,
  before = null,
}) {
  const outer = useRef(null);
  const ref = useRef(null);
  const cells = useRef([]);
  const pendingFocus = useRef(null);
  const [active, setActive] = useState(0);
  const [pitch, setPitch] = useState(0);
  const [range, setRange] = useState({ start: 0, end: 0 });

  useEffect(() => {
    setActive((i) => Math.min(Math.max(0, i), Math.max(0, files.length - 1)));
  }, [files.length]);

  // One row's height, from the first mounted row. Every row is the same
  // height by construction (one line, fixed thumbnail), which is what makes a
  // fixed pitch safe.
  const measure = useCallback(() => {
    const row = ref.current?.firstElementChild;
    const h = row ? row.getBoundingClientRect().height : 48;
    setPitch((p) => (Math.abs(p - h) < 0.5 ? p : Math.max(1, h)));
  }, []);

  const updateRange = useCallback(() => {
    const el = outer.current;
    if (!el || !pitch) return;
    const { start, end } = rowWindow({
      top: el.getBoundingClientRect().top,
      viewport: window.innerHeight,
      pitch,
      rowCount: files.length,
      overscan: OVERSCAN_ROWS,
    });
    setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
  }, [pitch, files.length]);

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

  useEffect(() => {
    const i = pendingFocus.current;
    if (i == null) return;
    const el = cells.current[i];
    if (!el) return;
    pendingFocus.current = null;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest' });
  });

  const focusRow = useCallback((i) => {
    const next = Math.min(Math.max(0, i), files.length - 1);
    setActive(next);
    pendingFocus.current = next;
    const el = cells.current[next];
    if (el) {
      pendingFocus.current = null;
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'nearest' });
    } else if (outer.current && pitch) {
      const top = outer.current.getBoundingClientRect().top + window.scrollY + next * pitch;
      const bottom = top + pitch;
      if (top < window.scrollY) window.scrollTo(0, top);
      else if (bottom > window.scrollY + window.innerHeight) window.scrollTo(0, bottom - window.innerHeight);
    }
  }, [files.length, pitch]);

  const onKeyDown = useCallback((e, index) => {
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    const moves = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: files.length - 1 };
    if (e.key in moves) {
      e.preventDefault();
      focusRow(moves[e.key]);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpen?.(files[index]);
      return;
    }
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      onSelect?.(files[index]);
    }
  }, [files, focusRow, onOpen, onSelect]);

  if (!files.length && !before) return emptyState || null;

  const first = range.start;
  const last = Math.min(files.length, range.end);
  const tabbable = active >= first && active < last ? active : first;

  return (
    <div className="filelist">
      <FileListHeader sort={sort} onSort={onSort} />
      {before}
      {files.length === 0 ? emptyState : (
        <div ref={outer} className="filelist-body" style={{ position: 'relative', height: files.length * pitch || undefined }}>
          <div
            role="listbox"
            aria-label={label}
            aria-multiselectable="true"
            ref={ref}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${first * pitch}px)` }}
          >
            {files.slice(first, Math.max(last, first + 1)).map((f, n) => {
              const i = first + n;
              const isSel = selected?.has(f.id) || false;
              const type = labelFor?.(f) || f.kind || '';
              return (
                <div
                  key={f.id}
                  role="option"
                  aria-selected={isSel}
                  data-file-id={f.id}
                  className={`filelist-row filelist-cols${isSel ? ' is-selected' : ''}`}
                  tabIndex={i === tabbable ? 0 : -1}
                  ref={(el) => { cells.current[i] = el; }}
                  onKeyDown={(e) => onKeyDown(e, i)}
                  onClick={() => { setActive(i); onSelect?.(f); }}
                  onDoubleClick={() => onOpen?.(f)}
                  draggable={!!onDragFile}
                  onDragStart={onDragFile ? (e) => onDragFile(f, e) : undefined}
                >
                  <span className="filelist-thumb">
                    <Thumb file={f} label={type} onMissingThumb={onMissingThumb} />
                  </span>
                  <span className="filelist-name">
                    <span className="truncate" title={f.name}>{f.name}</span>
                    {badgesFor?.(f)}
                  </span>
                  <span className="filelist-col-size muted">{fmtSize(f.size) || '—'}</span>
                  <span className="filelist-col-type muted truncate" title={f.mime || undefined}>{type}</span>
                  <span className="filelist-col-modified muted"><Modified at={f.updatedAt} /></span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
