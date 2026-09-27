'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { effectiveKind, drawableKind } from '@/lib/media';
import { probedNow, decodeProbe } from '@/lib/decode-probe';
import VideoPlayer from '@/app/components/video/VideoPlayer';
import ImageStage from './ImageStage';
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
 *   audio  <audio controls> (AudioStage), with the same seekTo/time handle
 *          as the player, for the transcript.
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
 * share page renders this with none of them. So are the transcript's:
 * `onTime` (the playhead, for the line to light) and `captions` (a video's
 * subtitles track), and `proxy` — useProxy's return value, which lets the
 * player prefer a rendition and offer to have one made. Without it the player
 * falls back to whatever the row was presigned with.
 */
const FilePreview = forwardRef(function FilePreview({
  file, startAt = 0, overlay = null, markers = null, onMarkerClick, onFrameChange, onRangeChange, onComment,
  handoff = null, onOriginalBlob, onTime, captions = null, proxy = null,
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
  // it can draw — which, for those two, a quick probe of this browser says
  // (lib/decode-probe.js; Safari can).
  const renditions = !!(file.posterUrl || file.thumbnailUrl);
  const [probe, setProbe] = useState(probedNow);
  const probeWorth = kind === 'image' && !renditions && !probe && /heic|heif|tiff?/i.test(`${file.mime || ''} ${file.name || ''}`);
  useEffect(() => {
    if (probeWorth) decodeProbe().then(setProbe, () => {});
  }, [probeWorth]);
  if (kind === 'image' && (renditions || drawableKind(file, { probe })) && !failed) {
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
        onTime={onTime}
        captions={captions}
        proxy={proxy}
      />
    );
  }

  if (kind === 'audio') {
    return <AudioStage ref={ref} file={file} onTime={onTime} style={{ ...box, minHeight: 120, padding: 'var(--s5)' }} />;
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
 * An audio file: the browser's own controls, and the handle the transcript
 * uses on a video's player — seekTo(seconds), time() — so a line of an
 * interview's transcript lands on its moment the same way.
 */
const AudioStage = forwardRef(function AudioStage({ file, onTime, style }, ref) {
  const audio = useRef(null);
  useImperativeHandle(ref, () => ({
    seekTo: (seconds) => {
      const a = audio.current;
      if (!a || !Number.isFinite(seconds)) return;
      a.currentTime = Math.max(0, seconds);
      onTime?.(a.currentTime);
    },
    pause: () => audio.current?.pause(),
    time: () => audio.current?.currentTime || 0,
  }), [onTime]);
  return (
    <div style={style}>
      <audio
        ref={audio}
        src={file.url}
        controls
        preload="metadata"
        style={{ width: '100%' }}
        onTimeUpdate={(e) => onTime?.(e.target.currentTime)}
        onSeeked={(e) => onTime?.(e.target.currentTime)}
      />
    </div>
  );
});
