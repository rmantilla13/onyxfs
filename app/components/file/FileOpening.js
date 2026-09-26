'use client';

import { useEffect } from 'react';
import { effectiveKind } from '@/lib/media';
import FileDetailFrame from './FileDetailFrame';
import ImageStage from './ImageStage';
import ProgressiveImage from '@/app/components/media/ProgressiveImage';
import '@/app/components/review/review.css';

/**
 * A file's page before the server has rendered it: the same header, the same
 * stage, the same inspector column — with the picture the files view was
 * already showing, sharpening to the large preview as it arrives. Built only
 * from the listing's row (lib/file-handoff.js), so it is on screen in the
 * frame after the double-click, however long the server takes; when the page
 * replaces it, the picture is where it was and the same URLs are cached.
 */
export default function FileOpening({ file, handoff = null, backHref = '/files', as = 'div', className = '' }) {
  const kind = effectiveKind(file);
  useEffect(() => {
    try { performance.mark('onyx:open:shell', { detail: { id: file?.id ?? null } }); } catch {}
  }, [file?.id]);
  if (!file) return null;

  const md = file.metadata || {};
  const w = Number(md.width) || Number(handoff?.natural?.w) || 0;
  const h = Number(md.height) || Number(handoff?.natural?.h) || 0;
  const ratio = w && h ? w / h : 16 / 9;

  let stage;
  if (kind === 'image' && (file.thumbnailUrl || file.posterUrl || handoff?.currentSrc)) {
    stage = <ImageStage file={file} handoff={handoff} shell />;
  } else if (kind === 'video') {
    // The player's stage, with the poster (or the tile's picture) in it.
    const layers = [
      { src: handoff?.currentSrc || file.thumbnailUrl, quality: 'thumb' },
      { src: file.posterUrl, quality: 'preview' },
    ].filter((l) => l.src);
    stage = (
      <div className="player">
        <div className="player-stage is-shell" style={{ '--ratio': ratio }}>
          {layers.length > 0 && <ProgressiveImage key={file.id} id={file.id} layers={layers} alt="" />}
        </div>
        <div className="player-bar is-shell" aria-hidden />
      </div>
    );
  } else {
    stage = <div className="image-stage file-opening-stage" style={{ '--ratio': 4 / 3 }} />;
  }

  return (
    <FileDetailFrame
      as={as}
      className={`file-opening ${className}`.trim()}
      aria-busy="true"
      header={(
        <>
          <a className="btn btn-ghost btn-sm" href={backHref}>← Back</a>
          <h1 className="truncate" style={{ fontSize: 'var(--t-xl)', minWidth: 0 }} title={file.name}>{file.name}</h1>
          <div className="spacer" />
          {/* Holds the header's height, as the page's own buttons will. */}
          <span className="btn file-opening-hold" aria-hidden>Download</span>
        </>
      )}
      stage={stage}
      aside={(
        <div className="card file-opening-aside" aria-hidden>
          <span className="skeleton-line" />
          <span className="skeleton-line is-short" />
          <span className="skeleton-line" />
          <span className="skeleton-line is-short" />
        </div>
      )}
    />
  );
}
