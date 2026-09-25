'use client';

import { useEffect, useRef, useState } from 'react';
import { effectiveKind, drawableKind, fmtDuration, GRID_ORIGINAL_MAX_BYTES } from '@/lib/media';

/**
 * One file card, for the library grid and the public share grid — which had
 * two copies of this markup with different tile sizes and thumbnail rules.
 *
 * The card is a `div` with `role="option"`, not a button. It sits inside a
 * `role="listbox"` grid, where a button child is invalid, and a card will
 * eventually carry its own controls (download, menu) which cannot be nested
 * inside a button at all. Selection is `aria-selected`; the grid owns the
 * tab order (see FileGrid) so only one card is ever in it.
 *
 * `href` turns it into a link instead — used by the share page, where a card
 * is a download rather than a selection.
 *
 * `onMissingThumb(file)` is called once a tile that should have a thumbnail
 * and does not comes into view; the library passes the backfill queue.
 */

const fmtSize = (n) => {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
};

export { fmtSize };

function Thumb({ file, label, onMissingThumb }) {
  const kind = effectiveKind(file);
  const drawable = drawableKind(file);
  // URLs that failed to load in this tile. A broken-image icon is never the
  // answer: a dead thumbnail falls back to the original, then to the label.
  const [failed, setFailed] = useState(() => new Set());
  const ref = useRef(null);

  // A video's poster is its thumbnail or nothing — never the original, which
  // would pull a multi-gigabyte master into an <img> that cannot show it. An
  // image's original stands in only while small and in a format <img> draws.
  const original = drawable === 'image' && Number(file.size || 0) <= GRID_ORIGINAL_MAX_BYTES ? file.url : null;
  const src = [file.thumbnailUrl, original].find((u) => u && !failed.has(u)) || null;
  const needsThumb = !!onMissingThumb && !!drawable && (!file.thumbnailUrl || failed.has(file.thumbnailUrl));

  // Ask for a thumbnail only once the tile is near the viewport, so opening a
  // folder of thousands does not decode thousands of originals.
  useEffect(() => {
    const el = ref.current;
    if (!needsThumb || !el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); onMissingThumb(file); }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [needsThumb, file, onMissingThumb]);

  const duration = kind === 'video' ? fmtDuration(file.metadata?.duration) : '';
  return (
    <div
      ref={ref}
      className="filecard-thumb"
      style={{ aspectRatio: '4/3', background: 'var(--surface-sunken)', display: 'grid', placeItems: 'center', overflow: 'hidden', position: 'relative' }}
    >
      {src
        ? (
          <img
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setFailed((prev) => new Set(prev).add(src))}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        )
        : <span className="muted small mono">{label || kind}</span>}
      {kind === 'video' && <span className="filecard-badge">{duration ? `▶ ${duration}` : '▶'}</span>}
    </div>
  );
}

function Body({ file, label, badges, onMissingThumb }) {
  return (
    <>
      <Thumb file={file} label={label} onMissingThumb={onMissingThumb} />
      <div style={{ padding: 10 }}>
        <div className="small truncate" title={file.name}>{file.name}</div>
        <div className="row small muted" style={{ gap: 6, marginTop: 4 }}>
          <span>{fmtSize(file.size)}</span>
          <div className="spacer" />
          {badges}
        </div>
      </div>
    </>
  );
}

export default function FileCard({
  file,
  label,
  badges = null,
  selected = false,
  onSelect,
  onOpen,
  href,
  downloadName,
  tabIndex = -1,
  innerRef,
  onKeyDown,
  onMissingThumb,
  onDragStart,
}) {
  if (href) {
    return (
      <a className="card filecard" href={href} download={downloadName} ref={innerRef}>
        <Body file={file} label={label} badges={badges} onMissingThumb={onMissingThumb} />
      </a>
    );
  }

  return (
    <div
      className="card filecard"
      role="option"
      aria-selected={selected}
      // Lets the library find which file a right-click or the menu key was on
      // without threading a handler through every card.
      data-file-id={file.id}
      tabIndex={tabIndex}
      ref={innerRef}
      onKeyDown={onKeyDown}
      // A click selects, as it always did. Opening is a double-click or
      // Enter, so a click never costs a request for a preview nobody asked
      // for.
      onClick={onSelect}
      onDoubleClick={onOpen}
      // Draggable onto a folder in the sidebar, when the library allows moves.
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      style={selected ? { outline: '2px solid var(--accent)', outlineOffset: -1 } : undefined}
    >
      <Body file={file} label={label} badges={badges} onMissingThumb={onMissingThumb} />
    </div>
  );
}
