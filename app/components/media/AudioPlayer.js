'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import Icon from '@/app/components/ui/Icon';
import { fmtDuration } from '@/lib/media';
import Waveform from './Waveform';
import './audio.css';

const STEP_SECONDS = 5;
const clock = (s) => fmtDuration(s) || '0:00';

/**
 * A sound, played: a play button, the sound's waveform (lib/waveform.js) as
 * the scrubber — pressed or dragged anywhere to go there, or with the arrow
 * keys once it has focus — and where it is out of how long. A sound with no
 * waveform yet has a plain track in its place, and gets its waveform the
 * moment the backfill records one (the row changes; playback does not).
 *
 * The playhead is a custom property on the scrubber (--played, 0 to 1),
 * moved every frame while playing without re-rendering anything; the time
 * beside it follows the element's own timeupdate.
 *
 * The handle is the one the transcript uses on a video's player —
 * seekTo(seconds), pause(), time() — so a line of an interview lands on its
 * moment the same way.
 */
const AudioPlayer = forwardRef(function AudioPlayer({ file, autoPlay = false, onTime, bars = 160, className = '' }, ref) {
  const audio = useRef(null);
  const scrub = useRef(null);
  const dragging = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(() => Number(file.metadata?.duration) || 0);
  const [failed, setFailed] = useState(false);

  const length = useCallback(() => {
    const d = audio.current?.duration;
    return Number.isFinite(d) && d > 0 ? d : duration;
  }, [duration]);

  const paint = useCallback((t) => {
    const d = length();
    scrub.current?.style.setProperty('--played', d > 0 ? String(Math.min(1, Math.max(0, t / d))) : '0');
  }, [length]);

  useEffect(() => {
    if (!playing) return undefined;
    let frame = 0;
    const tick = () => {
      if (audio.current) paint(audio.current.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, paint]);

  const seek = useCallback((seconds) => {
    const a = audio.current;
    if (!a || !Number.isFinite(seconds)) return;
    const d = length();
    const t = Math.max(0, d > 0 ? Math.min(seconds, d) : seconds);
    a.currentTime = t;
    setTime(t);
    paint(t);
    onTime?.(t);
  }, [length, paint, onTime]);

  useImperativeHandle(ref, () => ({
    seekTo: seek,
    pause: () => audio.current?.pause(),
    time: () => audio.current?.currentTime || 0,
  }), [seek]);

  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  };

  const secondsAt = (e) => {
    const r = scrub.current.getBoundingClientRect();
    return r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * length() : 0;
  };
  const onPointerDown = (e) => {
    if (e.button !== 0 || !(length() > 0) || failed) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    seek(secondsAt(e));
  };
  const onPointerMove = (e) => { if (dragging.current) seek(secondsAt(e)); };
  const endDrag = (e) => {
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };
  // A focused scrubber keeps its keys: the arrows move the playhead here,
  // not to the next file in Quick Look, and Space plays or pauses.
  const onKeyDown = (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      toggle();
      return;
    }
    const d = length();
    const now = audio.current?.currentTime || 0;
    const to = {
      ArrowLeft: now - STEP_SECONDS, ArrowDown: now - STEP_SECONDS,
      ArrowRight: now + STEP_SECONDS, ArrowUp: now + STEP_SECONDS,
      PageDown: now - d / 10, PageUp: now + d / 10, Home: 0, End: d,
    }[e.key];
    if (to == null) return;
    e.preventDefault();
    e.stopPropagation();
    seek(to);
  };

  const wave = file.metadata?.waveform;
  return (
    <div className={`audio-player ${className}`.trim()}>
      <audio
        ref={audio}
        src={file.url}
        preload="metadata"
        autoPlay={autoPlay}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d) && d > 0) setDuration(d); }}
        onDurationChange={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d) && d > 0) setDuration(d); }}
        onTimeUpdate={(e) => {
          const t = e.currentTarget.currentTime;
          setTime(t);
          if (!playing) paint(t);
          onTime?.(t);
        }}
        onSeeked={(e) => onTime?.(e.currentTarget.currentTime)}
        onError={() => setFailed(true)}
      />
      <button
        type="button"
        className="btn btn-primary btn-icon audio-play"
        onClick={toggle}
        disabled={failed}
        aria-label={playing ? 'Pause' : 'Play'}
      >
        <Icon name={playing ? 'pause' : 'play'} size={18} strokeWidth={2} fill="currentColor" />
      </button>
      <div
        ref={scrub}
        className={`audio-scrub${wave ? '' : ' is-flat'}`}
        role="slider"
        tabIndex={failed ? -1 : 0}
        aria-label={`Position in ${file.name || 'the sound'}`}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration) || 0}
        aria-valuenow={Math.round(time)}
        aria-valuetext={`${clock(time)} of ${clock(duration)}`}
        aria-disabled={failed || undefined}
        // Pressing the waveform moves the playhead; it does not take focus
        // from where the keyboard was (Quick Look's arrows go on working).
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        {wave ? (
          <>
            <Waveform waveform={wave} count={bars} className="audio-wave" />
            <span className="audio-played"><Waveform waveform={wave} count={bars} tone="aura" className="audio-wave" /></span>
          </>
        ) : (
          <>
            <span className="audio-track" />
            <span className="audio-played"><span className="audio-track audio-track-played" /></span>
          </>
        )}
        <span className="audio-head" />
      </div>
      <span className="audio-time">{clock(time)} / {clock(duration)}</span>
      {failed && <p className="audio-failed small muted">This browser cannot play this format. Download it to listen.</p>}
    </div>
  );
});

export default AudioPlayer;
