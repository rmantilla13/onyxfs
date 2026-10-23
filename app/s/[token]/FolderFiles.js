'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import FileCard, { Thumb } from '@/app/components/ui/FileCard';
import Icon from '@/app/components/ui/Icon';
import { deriveAuto } from '@/lib/dam';
import { fmtSize } from '@/lib/media';
import { kindLabel } from '@/lib/file-info';
import { thumbSources } from '@/lib/renditions';

// Cards on screen before anything else is: loaded at once, first.
const EAGER_CARDS = 8;
// A gallery column, for the pictures' srcset before the page is measured.
const GALLERY_SIZES = '(max-width: 719px) calc(50vw - 24px), (max-width: 1199px) 33vw, 25vw';

const labelFor = (f) => deriveAuto(f).format || f.kind;

/** A gallery picture's shape, from its recorded size: what keeps the columns from jumping as pictures arrive. */
const ratioOf = (f) => {
  const w = Number(f.metadata?.width);
  const h = Number(f.metadata?.height);
  return w > 0 && h > 0 ? `${w} / ${h}` : '4 / 3';
};

/** One file in the gallery: its picture at its own shape, its name over it on hover and focus. */
function GalleryTile({ file, href, eager }) {
  const { src, srcSet } = thumbSources(file, 'card', { sizes: GALLERY_SIZES });
  return (
    <a className="share-gallery-tile" href={href} title={file.name}>
      {src ? (
        <img
          src={src}
          srcSet={srcSet}
          sizes={srcSet ? GALLERY_SIZES : undefined}
          alt=""
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          style={{ aspectRatio: ratioOf(file) }}
        />
      ) : (
        <span className="share-gallery-blank" style={{ aspectRatio: '4 / 3' }}>
          <span className="mono small">{(labelFor(file) || 'file').toUpperCase()}</span>
        </span>
      )}
      <span className="share-gallery-name truncate">{file.name}</span>
    </a>
  );
}

/**
 * The files of one folder of a folder link, in the link's view — `grid`,
 * the library's cards; `list`, rows with each file's kind and size;
 * `gallery`, the pictures large at their own shapes — each a link to the
 * file's own page under the link, with its download beside it when the
 * link allows downloads, and the next page when the end comes near (or on
 * the button, which is there for a keyboard and for when the observer is
 * not).
 *
 * A guest's grid: no selection, no menus, nothing that edits, and no
 * thumbnail backfill (FileCard's onMissingThumb is for someone who may edit
 * the file). Every page comes from /s/<token>/list, which decides again
 * whether the link still lets this browser in.
 */
export default function FolderFiles({ token, sub = '', initial = [], cursor: firstCursor = null, view = 'grid', downloads = true }) {
  const [files, setFiles] = useState(initial);
  const [cursor, setCursor] = useState(firstCursor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const sentinel = useRef(null);
  const inflight = useRef(false);

  const base = `/s/${encodeURIComponent(token)}`;
  const fileHref = (f) => `${base}/files/${encodeURIComponent(f.id)}`;

  const more = useCallback(async () => {
    if (!cursor || inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ cursor });
      if (sub) qs.set('path', sub);
      const r = await fetch(`${base}/list?${qs}`, { cache: 'no-store' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(body.error || `Could not load more (HTTP ${r.status}).`);
        return;
      }
      setFiles((prev) => {
        const seen = new Set(prev.map((f) => f.id));
        return [...prev, ...(body.files || []).filter((f) => !seen.has(f.id))];
      });
      setCursor(body.cursor || null);
    } catch (e) {
      setError(e.message || 'Could not load more.');
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }, [base, cursor, sub]);

  // The next page as the end of the grid comes into view — once, not again
  // after a failure: then the button is the way to try again.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !cursor || error || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) more();
    }, { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, error, more]);

  const download = (f, className) => downloads && (
    <a className={`btn btn-icon ${className}`} href={`${fileHref(f)}/download`} aria-label={`Download ${f.name}`} title="Download">
      <Icon name="download" size={16} />
    </a>
  );

  let items;
  if (view === 'list') {
    items = (
      <ul className="share-rows">
        {files.map((f) => (
          <li key={f.id} className="share-rows-item">
            <a className="share-rows-link" href={fileHref(f)}>
              <span className="share-rows-thumb"><Thumb file={f} label={labelFor(f)} surface="row" /></span>
              <span className="share-rows-name truncate" title={f.name}>{f.name}</span>
              <span className="share-rows-kind small muted truncate">{kindLabel(f)}</span>
              <span className="share-rows-size small muted">{f.size != null ? fmtSize(f.size) : ''}</span>
            </a>
            {download(f, 'btn-ghost share-rows-download')}
          </li>
        ))}
      </ul>
    );
  } else if (view === 'gallery') {
    items = (
      <div className="share-gallery">
        {files.map((f, i) => <GalleryTile key={f.id} file={f} href={fileHref(f)} eager={i < EAGER_CARDS} />)}
      </div>
    );
  } else {
    items = (
      <div className="files-grid">
        {files.map((f, i) => (
          <div key={f.id} className="share-tile">
            <FileCard file={f} href={fileHref(f)} label={labelFor(f)} eager={i < EAGER_CARDS} />
            {download(f, 'share-tile-download')}
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      {items}
      {cursor && (
        <div className="share-more" ref={sentinel}>
          <button type="button" className="btn" onClick={more} disabled={busy}>
            {busy ? 'Loading…' : 'Show more'}
          </button>
        </div>
      )}
      {error && <p className="small share-more-error" role="alert">{error}</p>}
    </>
  );
}
