'use client';

import { useState } from 'react';
import { effectiveKind, drawableKind } from '@/lib/media';

/**
 * The preview pane of the detail view.
 *
 * Deliberately four narrow cases rather than one generic viewer:
 *
 *   image  a plain <img>. NOT next/image — the optimizer would cache a
 *          presigned URL and keep serving it after it expires.
 *   video  <video> with playsInline (iOS Safari otherwise takes over the
 *          screen on play) and preload="metadata" (auto-preloading a 4 GB
 *          master on a phone is a real bill, not a hypothetical one).
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
 */

// Above this, streaming a master straight from object storage is slow enough
// that saying so beats letting someone watch a spinner. ROADMAP 2.8 (HLS
// proxies) is the real fix.
const HEAVY_BYTES = 500 * 1024 * 1024;

export default function FilePreview({ file }) {
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
  const fill = { maxWidth: '100%', maxHeight: '70vh', display: 'block' };

  if (kind === 'image' && drawableKind(file) && !failed) {
    return (
      <div style={box}>
        <img src={file.url} alt={file.name} style={{ ...fill, objectFit: 'contain' }} onError={() => setFailed(true)} />
      </div>
    );
  }

  if (kind === 'video' && !failed) {
    return (
      <div className="stack" style={{ gap: 'var(--s2)' }}>
        <div style={box}>
          <video
            src={file.url}
            poster={file.thumbnailUrl || undefined}
            controls
            playsInline
            preload="metadata"
            onError={() => setFailed(true)}
            style={fill}
          />
        </div>
        {file.size > HEAVY_BYTES && (
          <p className="small muted" style={{ margin: 0 }}>
            Large file — playback may buffer while it streams. Downloading is faster if you need to scrub.
          </p>
        )}
      </div>
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
}
