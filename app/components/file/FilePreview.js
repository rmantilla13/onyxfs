'use client';

import { forwardRef, useRef, useState } from 'react';
import { effectiveKind, drawableKind } from '@/lib/media';
import VideoPlayer from '@/app/components/video/VideoPlayer';
import useContainedRect from '@/app/components/review/useContainedRect';
import '@/app/components/review/review.css';

/**
 * The preview pane of the detail view.
 *
 * Deliberately four narrow cases rather than one generic viewer:
 *
 *   image  ImageStage: a plain <img> — NOT next/image, whose optimizer would
 *          cache a presigned URL and keep serving it after it expires — with
 *          Fit / 100% and a slot for the review overlay on the picture.
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

  if (kind === 'image' && drawableKind(file) && !failed) {
    return <ImageStage file={file} overlay={overlay} onFailed={() => setFailed(true)} />;
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
 *   Fit   the picture contained in the stage; the frame that holds it (and
 *         the overlay) is placed on the contained rectangle, so a pin at 0.4
 *         is 0.4 of the picture, not of the grey around it.
 *   100%  one image pixel to one CSS pixel, in a stage that scrolls.
 *
 * Either way the overlay fills the frame the picture fills, so a drawing
 * made at Fit is on the same spot at 100%.
 */
function ImageStage({ file, overlay, onFailed }) {
  const stage = useRef(null);
  const md = file?.metadata || {};
  const [natural, setNatural] = useState({ w: Number(md.width) || 0, h: Number(md.height) || 0 });
  const [actual, setActual] = useState(false);
  const rect = useContainedRect(stage, natural.w, natural.h);
  const ratio = natural.w && natural.h ? natural.w / natural.h : 4 / 3;

  const frameStyle = actual && natural.w
    ? { width: natural.w, height: natural.h }
    : { left: rect.x, top: rect.y, width: rect.width, height: rect.height };

  return (
    <div className="image-stage-wrap">
      <div ref={stage} className={`image-stage${actual ? ' is-actual' : ''}`} style={{ '--ratio': ratio }}>
        <div className="image-frame" style={frameStyle}>
          <img
            src={file.url}
            alt={file.name}
            draggable={false}
            onLoad={(e) => {
              const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
              if (w && h) setNatural((n) => (n.w === w && n.h === h ? n : { w, h }));
            }}
            onError={onFailed}
          />
          {overlay && <div className="image-overlay">{overlay({ width: natural.w, height: natural.h })}</div>}
        </div>
      </div>
      <div className="image-stage-bar">
        <div className="view-toggle" role="group" aria-label="Zoom">
          <button type="button" className="btn btn-sm" aria-pressed={!actual} onClick={() => setActual(false)}>Fit</button>
          <button type="button" className="btn btn-sm" aria-pressed={actual} onClick={() => setActual(true)}>100%</button>
        </div>
        {natural.w > 0 && <span className="small muted mono">{natural.w} × {natural.h}</span>}
      </div>
    </div>
  );
}
