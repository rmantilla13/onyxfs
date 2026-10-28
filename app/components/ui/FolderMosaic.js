import FolderGlyph from '@/app/components/ui/FolderGlyph';

/**
 * A folder's picture: its newest few pictures as a mosaic — one fills it,
 * two side by side, three as one large and two small, four as a grid — with
 * a small folder on its corner, so it still reads as a folder beside the
 * files' own pictures. With nothing to show (`tiles` empty, or not known
 * yet: null) it is the folder alone, as it always was.
 *
 * `tiles` are lib/file-listing.js previewTile's. `size` is the square's edge
 * in CSS px (else the stylesheet's --mosaic); `large` picks a bigger
 * thumbnail: the sm sibling and then the grid poster, where a small square
 * takes the xs one. The pictures are
 * decoration: hidden from assistive tech, never dragged on their own (the
 * folder is what drags), and never the target of a click or a marquee.
 */
export default function FolderMosaic({ tiles, size = null, glyph = 44, large = false, className = '' }) {
  const shown = Array.isArray(tiles) ? tiles.slice(0, 4) : [];
  // Without a size the stylesheet's --mosaic decides (the folder tiles, by
  // card size and screen). The badge is sized from --mosaic there too.
  const style = size ? { '--mosaic': `${size}px` } : undefined;
  if (!shown.length) {
    return (
      <span className={`folder-mosaic is-empty${className ? ` ${className}` : ''}`} style={style} aria-hidden>
        <FolderGlyph size={glyph} />
      </span>
    );
  }
  return (
    <span className={`folder-mosaic is-${shown.length}${className ? ` ${className}` : ''}`} style={style} aria-hidden>
      <span className="folder-mosaic-cells">
        {shown.map((t, i) => {
          const src = large ? (t.sm || t.grid || t.xs) : (t.xs || t.sm || t.grid);
          return (
            <span
              key={t.id}
              className={`folder-mosaic-cell${shown.length === 3 && i === 0 ? ' is-lead' : ''}`}
              style={t.placeholder ? { backgroundImage: `url("${t.placeholder}")` } : undefined}
            >
              <img src={src} alt="" loading="lazy" decoding="async" draggable={false} />
            </span>
          );
        })}
      </span>
      <span className="folder-mosaic-badge"><FolderGlyph size={20} /></span>
    </span>
  );
}
