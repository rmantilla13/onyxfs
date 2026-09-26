'use client';

import { forwardRef, useState } from 'react';
import { effectiveKind, drawableKind } from '@/lib/media';
import { stageSources } from '@/lib/renditions';
import { probedNow } from '@/lib/decode-probe';
import VideoPlayer from '@/app/components/video/VideoPlayer';
import ProgressiveImage from '@/app/components/media/ProgressiveImage';
import '@/app/components/review/review.css';

/**
 * The preview pane of the detail view.
 *
 * Deliberately four narrow cases rather than one generic viewer:
 *
 *   image  ImageStage: the thumbnail at once, sharpening to the large
 *          preview (ProgressiveImage) — NOT next/image, whose optimizer
 *          would cache a presigned URL and keep serving it after it expires
 *          — with Fit / 100% and a slot for the review overlay on the
 *          picture. The original is loaded only at 100%, or when there is
 *          no preview.
 *   video  VideoPlayer, which owns playback, frames and its own overlay slot.
 *   audio  <audio controls>.
 *   else   the kind, and the download button that is always there anyway.
 *
 * A PDF is deliberately not iframed: a cross-origin presigned PDF does not
 * render in iOS Safari, so the fallback is more honest than a blank frame.
 *
 * Kind comes from effectiveKind, not the stored column: web uploads were all
 * recorded as 'other', which hid the player for every uploaded video. A format
 * the browser cannot draw (TIFF, HEIC, ProRes) says so instead of showing a
 * broken image or a player that never starts.
 *
 * The review props (overlay, markers, onFrameChange, onRangeChange,
 * onComment, and the ref, which reaches the player) are all optional: the
 * share page renders this with none of them.
 */
const FilePreview = forwardRef(function FilePreview({
  file, startAt = 0, overlay = null, markers = null, onMarkerClick, onFrameChange, onRangeChange, onComment,
  handoff = null, onOriginalBlob,
}, ref) {
  const kind = effectiveKind(file);
  const [failed, setFailed] = useState(false);
  const box = {
    display: 'grid',
    placeItems: 'center',
    background: 'var(--surface-sunken)',
    borderRadius: 'var(--radius)',
    minHeight: 280,
    overflow: 'hidden',
  };

  // Any image with a rendition shows it, whether or not this browser could
  // draw the original (a HEIC or TIFF, say); without one, only an original
  // it can draw.
  const renditions = !!(file.posterUrl || file.thumbnailUrl);
  if (kind === 'image' && (renditions || drawableKind(file, { probe: probedNow() })) && !failed) {
    return <ImageStage file={file} overlay={overlay} handoff={handoff} onOriginalBlob={onOriginalBlob} onFailed={() => setFailed(true)} />;
  }

  if (kind === 'video' && !failed) {
    // VideoPlayer owns the heavy-file notice, the preload decision and the
    // failure message now, so none of them are duplicated here. It falls back
    // to this component's placeholder only if it has no source at all — a
    // format the browser cannot decode is reported by the player itself, which
    // is the only thing that knows the decode failed.
    return (
      <VideoPlayer
        ref={ref}
        file={file}
        startAt={startAt}
        overlay={overlay}
        markers={markers}
        onMarkerClick={onMarkerClick}
        onFrameChange={onFrameChange}
        onRangeChange={onRangeChange}
        onComment={onComment}
      />
    );
  }

  if (kind === 'audio') {
    return (
      <div style={{ ...box, minHeight: 120, padding: 'var(--s5)' }}>
        <audio src={file.url} controls preload="metadata" style={{ width: '100%' }} />
      </div>
    );
  }

  return (
    <div style={box}>
      <div className="stack" style={{ gap: 'var(--s2)', textAlign: 'center', padding: 'var(--s5)' }}>
        <span className="muted mono">{(file.mime || kind || 'file').toUpperCase()}</span>
        {(kind === 'image' || kind === 'video') && (
          <span className="small muted">This browser cannot preview this format. Download it to view.</span>
        )}
      </div>
    </div>
  );
});

export default FilePreview;

/**
 * An image on a stage the shape of the image, the way the player stages a
 * video, with Fit and 100%.
 *
 *   Fit   the picture contained in the stage, from the thumbnail to the
 *         large preview (lib/renditions.js stageSources); the frame that
 *         holds it — and the overlay — is shaped by CSS, so a pin at 0.4 is
 *         0.4 of the picture, not of the grey around it.
 *   100%  one image pixel to one CSS pixel, in a stage that scrolls; the
 *         preview is shown enlarged until the original has decoded.
 *
 * Either way the overlay fills the frame the picture fills, so a drawing
 * made at Fit is on the same spot at 100%.
 *
 * `handoff` is what the files view handed over when it opened this file
 * (lib/file-handoff.js): the tile's picture, to start from. `shell` is the
 * opening shell (FileOpening), which draws the same stage before the page
 * exists. `onOriginalBlob` gets the original of a file with no preview, once
 * it has been fetched to show it — a writer's browser makes the preview from
 * it (lib/thumbnail-client.js).
 */
export function ImageStage({ file, overlay = null, onFailed, handoff = null, shell = false, onOriginalBlob }) {
  const md = file?.metadata || {};
  const [natural, setNatural] = useState(() => ({
    w: Number(md.width) || Number(handoff?.natural?.w) || 0,
    h: Number(md.height) || Number(handoff?.natural?.h) || 0,
  }));
  const [actual, setActual] = useState(false);
  const { thumb, preview, original } = stageSources(file, { probe: probedNow() });
  const layers = [
    { src: handoff?.currentSrc || thumb, quality: 'thumb' },
    { src: preview, quality: 'preview' },
    // The original only at 100%, or as the sharp layer when there is no preview.
    (actual || !preview) && !shell ? { src: original, quality: 'original' } : null,
  ].filter((l) => l && l.src);
  const ratio = natural.w && natural.h ? natural.w / natural.h : 4 / 3;
  const blob = !preview && original && onOriginalBlob ? onOriginalBlob : undefined;

  if (!layers.length) return null;

  return (
    <div className="image-stage-wrap">
      <div className={`image-stage${actual ? ' is-actual' : ''}`} style={{ '--ratio': ratio }}>
        <ProgressiveImage
          key={file.id}
          id={file.id}
          layers={layers}
          alt={file.name}
          actual={actual && natural.w > 0}
          width={natural.w}
          height={natural.h}
          onBlob={blob}
          onFailed={(q) => { if (q === 'thumb' || layers.length === 1) onFailed?.(); }}
          onSize={(w, h, quality) => {
            // Metadata first; else the original's own size, else any layer's shape.
            if (Number(md.width) && Number(md.height)) return;
            setNatural((n) => ((quality === 'original' || !n.w) && (n.w !== w || n.h !== h) ? { w, h } : n));
          }}
        >
          {overlay && <div className="image-overlay">{overlay({ width: natural.w, height: natural.h })}</div>}
        </ProgressiveImage>
      </div>
      <div className="image-stage-bar">
        <div className="view-toggle" role="group" aria-label="Zoom">
          <button type="button" className="btn btn-sm" aria-pressed={!actual} disabled={shell} onClick={() => setActual(false)}>Fit</button>
          <button type="button" className="btn btn-sm" aria-pressed={actual} disabled={shell} onClick={() => setActual(true)}>100%</button>
        </div>
        {natural.w > 0 && <span className="small muted mono">{natural.w} × {natural.h}</span>}
      </div>
    </div>
  );
}
