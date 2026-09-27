'use client';

import { useEffect, useRef, useState } from 'react';
import Dialog from '@/app/components/ui/Dialog';
import Icon from '@/app/components/ui/Icon';
import { posterTimes } from '@/lib/poster';
import { toRate, ASSUMED_RATE, frameAt, frameCount, secondsOfFrame, stepFrame, timecode } from '@/lib/video-time';

/**
 * Change a video's cover: scrub to a frame and set it as the picture the
 * video shows everywhere — grid, list, player poster, share pages, devices.
 * The frame is drawn, uploaded and recorded by setVideoCover
 * (lib/thumbnail-client.js), the path every thumbnail takes, at the chosen
 * time rather than the automatic one.
 *
 * Opens at `startAt` (the player's position on the file page), else where
 * the automatic cover is taken from. `onChanged(row)` gets the row, signed.
 */
export default function CoverDialog({ file, startAt = null, onClose, onChanged }) {
  const video = useRef(null);
  const md = file.metadata || {};
  const model = {
    fps: toRate(md.fps) || ASSUMED_RATE,
    tcStart: Number.isInteger(md.tcStart) ? md.tcStart : 0,
    dropFrame: md.dropFrame === true,
  };
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ratio = Number(md.width) > 0 && Number(md.height) > 0 ? `${md.width} / ${md.height}` : undefined;

  const seek = (t) => {
    const v = video.current;
    if (!v || !duration) return;
    const next = Math.min(Math.max(0, t), duration);
    v.currentTime = next;
    setTime(next);
    setError(null);
  };

  const onLoadedMetadata = () => {
    const v = video.current;
    const d = Number.isFinite(v?.duration) ? v.duration : 0;
    if (!d) return;
    setDuration(d);
    const at = Number.isFinite(startAt) && startAt > 0 ? startAt : posterTimes(d)[0];
    const t = Math.min(secondsOfFrame(frameAt(at, model.fps), model.fps), d);
    v.currentTime = t;
    setTime(t);
  };

  // A clip that loads between render and commit (from cache, say) fires its
  // loadedmetadata before React is listening, and React drops it.
  useEffect(() => {
    if (video.current?.readyState >= 1) onLoadedMetadata();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (busy || !duration) return;
    setBusy(true);
    setError(null);
    try {
      const { setVideoCover } = await import('@/lib/thumbnail-client');
      onChanged(await setVideoCover(file, video.current?.currentTime ?? time));
    } catch (e) {
      setError(e?.message || 'Could not change the cover.');
    } finally {
      setBusy(false);
    }
  };

  const step = (dir) => seek(stepFrame(time, dir, { fps: model.fps, duration, frames: md.frames }));
  // The slider counts frames, so an arrow key is one frame.
  const total = duration ? frameCount({ frames: md.frames, duration, fps: model.fps }) : 0;

  return (
    <Dialog
      open
      wide
      onClose={() => { if (!busy) onClose(); }}
      dismissable={!busy}
      title="Change cover"
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !duration}>
            {busy ? 'Saving…' : 'Set as cover'}
          </button>
        </>
      )}
    >
      <div className="stack" style={{ gap: 'var(--s3)' }}>
        <div className="player-stage" style={ratio ? { '--ratio': ratio } : undefined}>
          <video
            ref={video}
            src={file.url}
            poster={file.posterUrl || file.thumbnailUrl || undefined}
            muted
            playsInline
            preload="auto"
            onLoadedMetadata={onLoadedMetadata}
            onError={() => setError('This browser cannot play this video, so no frame can be picked from it.')}
          />
        </div>
        <div className="player-controls">
          <button type="button" className="btn btn-icon" onClick={() => step(-1)} disabled={!duration || busy} aria-label="Previous frame">
            <Icon name="step-back" />
          </button>
          <input
            type="range"
            className="cover-scrub"
            aria-label="Frame"
            min="0"
            max={Math.max(0, total - 1)}
            step="1"
            value={frameAt(time, model.fps)}
            disabled={!duration || busy}
            onChange={(e) => seek(secondsOfFrame(Number(e.target.value), model.fps))}
          />
          <button type="button" className="btn btn-icon" onClick={() => step(1)} disabled={!duration || busy} aria-label="Next frame">
            <Icon name="step-forward" />
          </button>
          <span className="small mono player-time">{timecode(frameAt(time, model.fps), model)}</span>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          Scrub to the frame you want, then set it as the cover. It replaces the current one everywhere this video is shown.
        </p>
        {error && <p className="small" role="alert" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p>}
      </div>
    </Dialog>
  );
}
