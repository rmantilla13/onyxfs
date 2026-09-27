'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { effectiveKind, drawableKind, fmtDuration, fmtSize } from '@/lib/media';
import { isUndersizedPoster, thumbSiblingSizes } from '@/lib/poster';
import { thumbSources } from '@/lib/renditions';
import { fileKey } from '@/lib/selection';
import { watch } from '@/lib/thumb-observer';
import Icon from '@/app/components/ui/Icon';
import { FieldLine } from './FieldValue';

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
 * What a press does is the page's (app/files/useSelectionModel.js), reached
 * through `handlers` — one stable object for every card, called with the
 * event and the card's key — so a card re-renders only when its own props
 * change: its row, whether it is selected, whether it holds the tab stop.
 * The card works out its own label and badges (`labelFor`, `badgesFor`),
 * which would otherwise be new elements on every render of the grid.
 *
 * `href` turns it into a link instead — used by the share page, where a card
 * is a download rather than a selection.
 *
 * `onMissingThumb(file, opts)` asks the backfill queue (lib/thumbnail-client.js)
 * for what the tile lacks, once it is near the screen: a thumbnail, a sharper
 * one than the old 480px ones, or its smaller siblings.
 */

// Lives in lib/media.js so server pages can use it too; re-exported here for
// the components that already import it from this module.
export { fmtSize };

// A card's box before the grid is measured: a 240px column's 4:3 picture.
const CARD_BOX = { width: 240, height: 180 };

/** Whether a picture of `md` dimensions is smaller than `box` both ways, and so shown at its own size. */
function smallerThan(md, box) {
  const w = Number(md?.width);
  const h = Number(md?.height);
  return w > 0 && h > 0 && w < box.width && h < box.height;
}

/**
 * The picture of a file on a surface (lib/renditions.js): a card gets a
 * srcset of its sm sibling and the grid poster sized to the measured column
 * (`sizes`, CSS px); a list row, the palette and the storage pages its xs
 * sibling; Get info its sm. `eager` is for the first row of the grid, which
 * is on screen before anything else is.
 */
export const Thumb = memo(function Thumb({ file, label, onMissingThumb, surface = 'card', sizes, eager = false, fitMode = 'fill' }) {
  const kind = effectiveKind(file);
  const drawable = drawableKind(file);
  // URLs that failed to load in this tile. A broken-image icon is never the
  // answer: a dead sibling falls back to the grid poster, that to a small
  // original, and that to the label.
  const [failed, setFailed] = useState(() => new Set());
  // `cover` fills the tile; a view set to Fit (`fitMode`) shows the whole
  // picture inside it instead. Either way a picture smaller than the tile in
  // both directions — an icon, a small screenshot — is shown at its own size
  // instead of blown up into a blur. Decided from the recorded dimensions
  // when there are some, so it never switches once the picture is up.
  const box = typeof sizes === 'number' && sizes > 0 ? { width: sizes, height: sizes * 0.75 } : CARD_BOX;
  const known = Number(file.metadata?.width) > 0 && Number(file.metadata?.height) > 0;
  const [measuredFit, setMeasuredFit] = useState(null);
  const whole = fitMode === 'fit' ? 'contain' : 'cover';
  const fit = surface === 'card' && known
    ? (smallerThan(file.metadata, box) ? 'scale-down' : whole)
    : measuredFit === 'scale-down' ? 'scale-down' : whole;
  const upgradeAsked = useRef(false);
  const ref = useRef(null);
  const imgRef = useRef(null);

  const { src, srcSet, sizes: sizesAttr } = thumbSources(file, surface, { sizes, failed });
  const hasSizes = Array.isArray(file.thumbSizes) && file.thumbSizes.length > 0;
  const needsThumb = !!onMissingThumb && !!drawable && (!file.thumbnailUrl || failed.has(file.thumbnailUrl));
  // A thumbnail from before siblings were made: an editor's browser draws
  // them from it (never from the original) once the tile is seen. Not for a
  // picture too small to have any.
  const needsSizes = !!onMissingThumb && !needsThumb && !!file.thumbnailUrl && !hasSizes
    && (!known || Object.keys(thumbSiblingSizes(file.metadata)).length > 0);

  // Asked once the tile is near the viewport, through one shared observer.
  useEffect(() => {
    const el = ref.current;
    if (!el || (!needsThumb && !needsSizes)) return undefined;
    return watch(el, () => onMissingThumb(file, needsThumb ? {} : { sizes: true }));
  }, [needsThumb, needsSizes, file, onMissingThumb]);

  const inspect = (img) => {
    if (!img || !img.naturalWidth) return;
    const natural = { width: img.naturalWidth, height: img.naturalHeight };
    if (!known) {
      const el = ref.current;
      const next = el && natural.width < el.clientWidth && natural.height < el.clientHeight ? 'scale-down' : 'cover';
      setMeasuredFit((f) => (f === next ? f : next));
    }
    // A thumbnail from before posters were sized for a 2x screen (480px on
    // the long edge) is remade, once, by someone who may edit the file. Known
    // by its decoded size against the source's recorded one (lib/poster.js),
    // so nothing has to be stored to tell old from new. Only the grid poster
    // itself is judged — a row with siblings was made after that change.
    const shown = img.currentSrc || img.src;
    if (onMissingThumb && !hasSizes && shown === file.thumbnailUrl && !upgradeAsked.current
        && isUndersizedPoster(natural, file.metadata)) {
      upgradeAsked.current = true;
      onMissingThumb(file, { upgrade: true });
    }
  };
  const onLoad = (e) => inspect(e.currentTarget);
  // The grid is server-rendered, and an image that finished loading before
  // hydration fired its `load` before React was listening — React does not
  // replay it — so a tile already on screen is inspected here instead.
  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete) inspect(img);
    // Once per picture; `inspect` reads the rest fresh on each call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const duration = kind === 'video' ? fmtDuration(file.metadata?.duration) : '';
  return (
    <div ref={ref} className="filecard-thumb">
      {src
        ? (
          <img
            ref={imgRef}
            src={src}
            srcSet={srcSet}
            sizes={sizesAttr}
            alt=""
            loading={eager ? 'eager' : 'lazy'}
            fetchPriority={eager ? 'high' : undefined}
            decoding="async"
            draggable={false}
            onLoad={onLoad}
            onError={(e) => {
              // With a srcset, what failed is whichever candidate was chosen.
              const bad = e.currentTarget.currentSrc || src;
              setFailed((prev) => new Set(prev).add(bad));
            }}
            style={{ objectFit: fit }}
          />
        )
        : <span className="muted small mono">{label || kind}</span>}
      {kind === 'video' && <span className="filecard-badge"><Icon name="play" size={10} strokeWidth={2.5} fill="currentColor" />{duration}</span>}
    </div>
  );
});

/**
 * Under the picture: the name, and the view's metadata fields as one line
 * (`fields`, lib/views.js) with any badges at its end. With no fields the
 * badges sit on the name's line, so the card is one line shorter — every
 * card in a grid shares the view's fields, so they stay one height, which
 * the virtualized grid relies on. Without `fields` at all (the share page)
 * the line is the size, as it always was.
 */
function Body({ file, label, badges, onMissingThumb, sizes, eager, fields, thumbFit, rootName }) {
  const line = fields === undefined
    ? <span>{fmtSize(file.size)}</span>
    : fields.length ? <FieldLine file={file} fields={fields} rootName={rootName} className="field-line truncate" /> : null;
  return (
    <>
      <Thumb file={file} label={label} onMissingThumb={onMissingThumb} sizes={sizes} eager={eager} fitMode={thumbFit} />
      <div className="filecard-text">
        {line ? (
          <>
            <div className="filecard-name truncate" title={file.name}>{file.name}</div>
            <div className="filecard-meta small muted">
              {line}
              {badges && <span className="filecard-badges">{badges}</span>}
            </div>
          </>
        ) : (
          <div className="filecard-meta">
            <span className="filecard-name truncate" title={file.name}>{file.name}</span>
            {badges && <span className="filecard-badges">{badges}</span>}
          </div>
        )}
      </div>
    </>
  );
}

function FileCard({
  file,
  label,
  badges = null,
  labelFor,
  badgesFor,
  selected = false,
  handlers = null,
  href,
  downloadName,
  tabIndex = -1,
  eager = false,
  sizes,
  onMissingThumb,
  fields,
  thumbFit = 'fill',
  rootName,
}) {
  const shownLabel = label ?? labelFor?.(file);
  const shownBadges = badges ?? badgesFor?.(file) ?? null;
  const body = (
    <Body
      file={file}
      label={shownLabel}
      badges={shownBadges}
      onMissingThumb={onMissingThumb}
      sizes={sizes}
      eager={eager}
      fields={fields}
      thumbFit={thumbFit}
      rootName={rootName}
    />
  );
  if (href) {
    return <a className="card filecard" href={href} download={downloadName}>{body}</a>;
  }

  const key = fileKey(file.id);
  const drag = handlers?.dragStart;
  return (
    <div
      className="card filecard"
      role="option"
      aria-selected={selected}
      // Lets the library find which file a right-click or the menu key was on
      // without threading a handler through every card.
      data-file-id={file.id}
      tabIndex={tabIndex}
      // A click selects (⌘ toggles, ⇧ extends); a double-click, Return or
      // ⌘↓ opens; on a touch screen a tap opens. See useSelectionModel.
      onClick={handlers ? (e) => handlers.click(e, key) : undefined}
      onDoubleClick={handlers ? (e) => handlers.dblclick(e, key) : undefined}
      onKeyDown={handlers ? (e) => handlers.keyDown(e, key) : undefined}
      // Draggable onto a folder in the sidebar, when the library allows moves.
      draggable={!!drag}
      onDragStart={drag ? (e) => drag(e, key) : undefined}
    >
      {body}
    </div>
  );
}

export default memo(FileCard);
