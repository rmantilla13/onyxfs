'use client';

import { useRef, useState } from 'react';
import { stageSources } from '@/lib/stage-sources';
import { probedNow } from '@/lib/decode-probe';
import { previewWanted } from '@/lib/preview-wanted';
import ProgressiveImage from '@/app/components/media/ProgressiveImage';
import '@/app/components/review/review.css';

/**
 * An image on a stage the shape of the image, the way the player stages a
 * video, with Fit and 100%.
 *
 *   Fit   the picture contained in the stage, from the thumbnail to the
 *         large preview (lib/stage-sources.js); the frame that
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
export default function ImageStage({ file, overlay = null, onFailed, handoff = null, shell = false, onOriginalBlob }) {
  const md = file?.metadata || {};
  const [natural, setNatural] = useState(() => ({
    w: Number(md.width) || Number(handoff?.natural?.w) || 0,
    h: Number(md.height) || Number(handoff?.natural?.h) || 0,
  }));
  const [actual, setActual] = useState(false);
  const { thumb, preview, original } = stageSources(file, { probe: probedNow() });
  // Once shown, the original stays (a preview made meanwhile must not blur it).
  const hadOriginal = useRef(false);
  if (!preview) hadOriginal.current = true;
  const layers = [
    { src: handoff?.currentSrc || thumb, quality: 'thumb' },
    { src: preview, quality: 'preview' },
    // The original only at 100%, or as the sharp layer when there is no preview.
    (actual || !preview || hadOriginal.current) && !shell ? { src: original, quality: 'original' } : null,
  ].filter((l) => l && l.src);
  const ratio = natural.w && natural.h ? natural.w / natural.h : 4 / 3;
  const blob = !preview && original && onOriginalBlob && previewWanted(file, { probe: probedNow() }) ? onOriginalBlob : undefined;

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
