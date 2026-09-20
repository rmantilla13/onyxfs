'use client';

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

function Thumb({ file, label }) {
  // A video's poster is its thumbnail or nothing — never the original, which
  // would pull a multi-gigabyte master into an <img> that cannot show it.
  // lib/thumbs.js skips videos over 200MB, so "no poster" is the common case
  // for exactly the files that most need one.
  const preview = file.thumbnailUrl || (file.kind === 'image' ? file.url : null);
  return (
    <div
      className="filecard-thumb"
      style={{ aspectRatio: '4/3', background: 'var(--surface-sunken)', display: 'grid', placeItems: 'center', overflow: 'hidden' }}
    >
      {preview
        ? <img src={preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
        : <span className="muted small mono">{label || file.kind}</span>}
    </div>
  );
}

function Body({ file, label, badges }) {
  return (
    <>
      <Thumb file={file} label={label} />
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
}) {
  if (href) {
    return (
      <a className="card filecard" href={href} download={downloadName} ref={innerRef}>
        <Body file={file} label={label} badges={badges} />
      </a>
    );
  }

  return (
    <div
      className="card filecard"
      role="option"
      aria-selected={selected}
      tabIndex={tabIndex}
      ref={innerRef}
      onKeyDown={onKeyDown}
      // A click selects, as it always did. Opening is a double-click or
      // Enter, so a click never costs a request for a preview nobody asked
      // for.
      onClick={onSelect}
      onDoubleClick={onOpen}
      style={selected ? { outline: '2px solid var(--accent)', outlineOffset: -1 } : undefined}
    >
      <Body file={file} label={label} badges={badges} />
    </div>
  );
}
