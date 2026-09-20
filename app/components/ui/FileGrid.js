'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import FileCard from './FileCard';

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
 */
export default function FileGrid({
  files,
  selected,
  onSelect,
  onOpen,
  badgesFor,
  labelFor,
  emptyState,
  label = 'Files',
}) {
  const ref = useRef(null);
  const cells = useRef([]);
  const [active, setActive] = useState(0);

  // Keep the roving index inside the list as it grows and shrinks. Without
  // this, filtering to fewer results leaves it pointing past the end and the
  // grid loses its tab stop entirely.
  useEffect(() => {
    setActive((i) => Math.min(Math.max(0, i), Math.max(0, files.length - 1)));
  }, [files.length]);

  // The column count is unknowable from `minmax(180px, 1fr)` — it depends on
  // the width the grid actually got. Read it back from layout.
  const columns = useCallback(() => {
    const el = ref.current;
    if (!el) return 1;
    const cols = window.getComputedStyle(el).gridTemplateColumns;
    return Math.max(1, cols.split(' ').filter(Boolean).length);
  }, []);

  const focusCell = useCallback((i) => {
    const next = Math.min(Math.max(0, i), files.length - 1);
    setActive(next);
    const el = cells.current[next];
    el?.focus();
    // 'nearest', or every keypress yanks the page to centre the card.
    el?.scrollIntoView({ block: 'nearest' });
  }, [files.length]);

  const onKeyDown = useCallback((e, index) => {
    // Never swallow a key meant for a text field inside a card.
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;

    const cols = columns();
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
  }, [columns, files, focusCell, onOpen, onSelect]);

  if (!files.length) return emptyState || null;

  return (
    <div className="files-grid" role="listbox" aria-label={label} aria-multiselectable="true" ref={ref}>
      {files.map((f, i) => (
        <FileCard
          key={f.id}
          file={f}
          label={labelFor?.(f)}
          badges={badgesFor?.(f)}
          selected={selected?.has(f.id) || false}
          tabIndex={i === active ? 0 : -1}
          innerRef={(el) => { cells.current[i] = el; }}
          onKeyDown={(e) => onKeyDown(e, i)}
          onSelect={() => { setActive(i); onSelect?.(f); }}
          onOpen={() => onOpen?.(f)}
        />
      ))}
    </div>
  );
}
