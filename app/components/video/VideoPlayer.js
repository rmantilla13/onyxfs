'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ASSUMED_FPS, timecode, stepFrame, timeFromPointer, percentOf,
  bufferedSpans, clampRange, shuttleRate, seekToDigit,
} from '@/lib/video-time';
import { frameIndexAt, framePosition, layoutFromMetadata } from '@/lib/filmstrip';
import { fmtDuration } from '@/lib/media';

/**
 * The video player.
 *
 * Replaces `<video controls>`, which gave no timecode, no frame stepping, no
 * range selection and a different control bar in every browser. Built on the
 * arithmetic in lib/video-time.js and lib/filmstrip.js so the parts that are
 * easy to get subtly wrong are tested without a browser.
 *
 * KEYBOARD, scoped to the player (a focusable container, not the document — a
 * global handler would swallow the space bar while someone is typing a filename
 * in a dialog three components away):
 *
 *   space / K   play-pause          , / .   step one frame
 *   J / L       shuttle, 1x…16x     ← / →   ±5s      ⇧←/⇧→  ±1s
 *   I / O       set in / out        ⇧X      clear the range
 *   M           mute                F       fullscreen
 *   0–9         seek to N×10%       Home/End  start / end
 *
 * HEAVY FILES. A multi-gigabyte master streamed from object storage seeks
 * badly, and every byte is egress. So while no proxy rendition exists the
 * player shows the poster and does not touch the master until someone presses
 * play — `preload="none"` until then. With a proxy it loads metadata eagerly,
 * because the proxy is small.
 */

// Above this, warn that seeking will buffer. Under it, streaming the original
// is fine and saying otherwise is noise.
const HEAVY_BYTES = 500 * 1024 * 1024;
const VOLUME_KEY = 'onyx.player.volume';
const SPEEDS = [0.25, 0.5, 1, 1.5, 2];

export default function VideoPlayer({ file, startAt = 0, onRangeChange }) {
  const video = useRef(null);
  const bar = useRef(null);
  const shell = useRef(null);
  const shuttle = useRef({ presses: 0, direction: 1 });

  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(Number(startAt) || 0);
  const [duration, setDuration] = useState(Number(file?.metadata?.duration) || 0);
  const [buffered, setBuffered] = useState([]);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(false);
  const [range, setRange] = useState({ inPoint: null, outPoint: null });
  const [hover, setHover] = useState(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [error, setError] = useState(null);
  // A proxy is small enough to preload; a master is not, so it waits for a
  // deliberate press. `started` is what flips preload on.
  const [started, setStarted] = useState(false);

  // The picture's shape, which decides the stage's size in every state. The
  // <video> element has no size of its own until its metadata arrives: with
  // preload="none" it shows the poster at the POSTER's pixel size — a small
  // thumbnail — and then jumps to the video's size on play. So the stage is
  // sized from this ratio instead, and the element fills it (object-fit keeps
  // both the poster and the picture contained). Known up front for uploads
  // (width/height are recorded with the thumbnail); otherwise the poster has
  // the clip's shape; the video's own metadata has the last word.
  const recorded = Number(file?.metadata?.width) > 0 && Number(file?.metadata?.height) > 0
    ? Number(file.metadata.width) / Number(file.metadata.height)
    : null;
  const [ratio, setRatio] = useState(recorded);
  useEffect(() => {
    if (ratio || !file?.thumbnailUrl) return undefined;
    let live = true;
    const img = new Image();
    img.onload = () => {
      if (live && img.naturalWidth && img.naturalHeight) setRatio((r) => r || img.naturalWidth / img.naturalHeight);
    };
    img.src = file.thumbnailUrl;
    return () => { live = false; };
  }, [ratio, file?.thumbnailUrl]);

  const proxy = file?.proxyUrl || null;
  const src = proxy || file?.url || null;
  const heavy = !proxy && Number(file?.size) > HEAVY_BYTES;
  const fps = Number(file?.metadata?.fps) > 0 ? Number(file.metadata.fps) : ASSUMED_FPS;
  const strip = useMemo(() => layoutFromMetadata(file?.metadata), [file?.metadata]);
  const stripUrl = file?.filmstripUrl || null;

  // Restore the volume this viewer last chose. Wrapped because storage throws
  // in a private window and returns nothing with site data cleared, and the
  // player must work in both.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(VOLUME_KEY) || 'null');
      if (saved && typeof saved.volume === 'number') {
        setVolume(Math.min(1, Math.max(0, saved.volume)));
        setMuted(!!saved.muted);
      }
    } catch { /* no stored preference */ }
  }, []);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.volume = volume;
    v.muted = muted;
    try { localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume, muted })); }
    catch { /* not worth surfacing */ }
  }, [volume, muted]);

  useEffect(() => { if (video.current) video.current.playbackRate = speed; }, [speed]);

  useEffect(() => { onRangeChange?.(range); }, [range, onRangeChange]);

  const seek = useCallback((to) => {
    const v = video.current;
    if (!v || !Number.isFinite(to)) return;
    const total = v.duration || duration;
    const clamped = Math.min(Math.max(0, to), total || to);
    v.currentTime = clamped;
    setCurrent(clamped);
  }, [duration]);

  const togglePlay = useCallback(() => {
    const v = video.current;
    if (!v) return;
    setStarted(true);
    if (v.paused) {
      shuttle.current = { presses: 0, direction: 1 };
      v.playbackRate = speed;
      // A rejected play() is normal — autoplay policy, or a source that will
      // not decode. Swallowing it silently leaves a dead button, so it is
      // reported.
      v.play().catch((e) => setError(e?.message || 'This video could not be played.'));
    } else {
      v.pause();
    }
  }, [speed]);

  const doShuttle = useCallback((direction) => {
    const v = video.current;
    if (!v) return;
    setStarted(true);
    const s = shuttle.current;
    s.presses = s.direction === direction ? s.presses + 1 : 1;
    s.direction = direction;
    const rate = shuttleRate(s.presses);
    if (direction < 0) {
      // Browsers do not play backwards: a negative playbackRate is ignored by
      // Chrome and throws in Safari. Reverse shuttle is stepping instead, which
      // is what it looks like anyway at 4x and above.
      v.pause();
      seek(v.currentTime - rate * 0.5);
    } else {
      v.playbackRate = rate;
      setSpeed(rate);
      v.play().catch(() => {});
    }
  }, [seek]);

  const setIn = useCallback(() => {
    setRange((r) => clampRange({ ...r, inPoint: video.current?.currentTime ?? 0 }, duration));
  }, [duration]);
  const setOut = useCallback(() => {
    setRange((r) => clampRange({ ...r, outPoint: video.current?.currentTime ?? 0 }, duration));
  }, [duration]);
  const clearRange = useCallback(() => setRange({ inPoint: null, outPoint: null }), []);

  const toggleFullscreen = useCallback(() => {
    const el = shell.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.().catch(() => {});
  }, []);

  const onKeyDown = useCallback((e) => {
    // Never steal a key from a field inside the player's subtree.
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    const v = video.current;
    if (!v) return;
    const big = e.shiftKey ? 1 : 5;
    const keys = {
      ' ': togglePlay, k: togglePlay, K: togglePlay,
      j: () => doShuttle(-1), J: () => doShuttle(-1),
      l: () => doShuttle(1), L: () => doShuttle(1),
      ',': () => { v.pause(); seek(stepFrame(v.currentTime, -1, { fps, duration })); },
      '.': () => { v.pause(); seek(stepFrame(v.currentTime, 1, { fps, duration })); },
      ArrowLeft: () => seek(v.currentTime - big),
      ArrowRight: () => seek(v.currentTime + big),
      ArrowUp: () => setVolume((x) => Math.min(1, x + 0.1)),
      ArrowDown: () => setVolume((x) => Math.max(0, x - 0.1)),
      Home: () => seek(0),
      End: () => seek(duration),
      i: setIn, I: setIn, o: setOut, O: setOut,
      X: clearRange,
      m: () => setMuted((x) => !x), M: () => setMuted((x) => !x),
      f: toggleFullscreen, F: toggleFullscreen,
    };
    if (keys[e.key]) { e.preventDefault(); keys[e.key](); return; }
    if (/^[0-9]$/.test(e.key)) {
      const to = seekToDigit(Number(e.key), duration);
      if (to != null) { e.preventDefault(); seek(to); }
    }
  }, [togglePlay, doShuttle, seek, fps, duration, setIn, setOut, clearRange, toggleFullscreen]);

  // Scrubbing uses pointer capture so a drag continues outside the bar — which
  // is most drags, because the bar is a few pixels tall.
  const scrubTo = (clientX) => {
    if (!bar.current) return;
    seek(timeFromPointer(clientX, bar.current.getBoundingClientRect(), duration));
  };

  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setScrubbing(true);
    setStarted(true);
    scrubTo(e.clientX);
  };
  const onPointerMove = (e) => {
    if (bar.current) {
      setHover(timeFromPointer(e.clientX, bar.current.getBoundingClientRect(), duration));
    }
    if (scrubbing) scrubTo(e.clientX);
  };
  const onPointerUp = (e) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setScrubbing(false);
  };

  if (!src) {
    return <div className="player-empty muted small">This file has no playable source.</div>;
  }

  const spans = bufferedSpans(buffered, duration);
  const played = percentOf(current, duration);
  const hoverPct = hover == null ? null : percentOf(hover, duration);
  const stripStyle = strip && stripUrl && hover != null
    ? { ...framePosition(frameIndexAt(hover, duration, strip.frames), strip), backgroundImage: `url(${stripUrl})` }
    : null;

  return (
    <div
      className={`player${playing ? ' is-playing' : ''}`}
      ref={shell}
      tabIndex={0}
      role="group"
      aria-label={`Video player for ${file.name}`}
      onKeyDown={onKeyDown}
    >
      <div className="player-stage" style={{ '--ratio': ratio || 16 / 9 }}>
        <video
          ref={video}
          src={src}
          poster={file.thumbnailUrl || undefined}
          playsInline
          // No picture-in-picture, the player's or the browser's hover button.
          disablePictureInPicture
          // Nothing is fetched until play is pressed on a master with no
          // proxy: opening a detail page should not cost a gigabyte of egress.
          preload={started || proxy ? 'metadata' : 'none'}
          onClick={togglePlay}
          onLoadedMetadata={(e) => {
            setReady(true);
            if (Number.isFinite(e.target.duration) && e.target.duration > 0) setDuration(e.target.duration);
            if (e.target.videoWidth && e.target.videoHeight) setRatio(e.target.videoWidth / e.target.videoHeight);
            // The ?t= deep link, applied once metadata exists — seeking before
            // that is discarded by every browser.
            if (Number(startAt) > 0) seek(Number(startAt));
          }}
          onTimeUpdate={(e) => {
            const t = e.target.currentTime;
            setCurrent(t);
            // Loop the selected range rather than the whole clip when one is
            // set: that is what a range is for.
            if (loop && range.inPoint != null && range.outPoint != null && t >= range.outPoint) {
              seek(range.inPoint);
            }
          }}
          onProgress={(e) => setBuffered(bufferedSpans(e.target.buffered, e.target.duration || duration))}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onVolumeChange={(e) => { setVolume(e.target.volume); setMuted(e.target.muted); }}
          onError={() => setError('This browser cannot decode this video. Download it to view.')}
          loop={loop && range.inPoint == null}
        />

        {!started && !proxy && (
          <button className="player-bigplay" onClick={togglePlay} aria-label="Play">
            <span aria-hidden="true">▶</span>
          </button>
        )}
      </div>

      {error && <p className="player-error small">{error}</p>}

      <div className="player-bar">
        <div
          className="player-scrub"
          ref={bar}
          role="slider"
          tabIndex={-1}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration) || 0}
          aria-valuenow={Math.round(current)}
          aria-valuetext={timecode(current, fps)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setHover(null)}
        >
          {spans.map((s, i) => (
            <span key={i} className="player-buffered" style={{ left: `${s.left}%`, width: `${s.width}%` }} />
          ))}
          {range.inPoint != null && range.outPoint != null && (
            <span
              className="player-range"
              style={{
                left: `${percentOf(range.inPoint, duration)}%`,
                width: `${percentOf(range.outPoint, duration) - percentOf(range.inPoint, duration)}%`,
              }}
            />
          )}
          <span className="player-played" style={{ width: `${played}%` }} />
          <span className="player-head" style={{ left: `${played}%` }} />
          {range.inPoint != null && <span className="player-mark in" style={{ left: `${percentOf(range.inPoint, duration)}%` }} />}
          {range.outPoint != null && <span className="player-mark out" style={{ left: `${percentOf(range.outPoint, duration)}%` }} />}

          {hoverPct != null && (
            <div className="player-hover" style={{ left: `${hoverPct}%` }}>
              {stripStyle && <div className="player-hover-frame" style={stripStyle} />}
              <span className="player-hover-time mono">{timecode(hover, fps)}</span>
            </div>
          )}
        </div>

        <div className="player-controls">
          <button className="btn btn-icon" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} aria-pressed={playing}>
            <span aria-hidden="true">{playing ? '❚❚' : '▶'}</span>
          </button>
          <button className="btn btn-icon" onClick={() => { video.current?.pause(); seek(stepFrame(current, -1, { fps, duration })); }} aria-label="Previous frame">
            <span aria-hidden="true">◀|</span>
          </button>
          <button className="btn btn-icon" onClick={() => { video.current?.pause(); seek(stepFrame(current, 1, { fps, duration })); }} aria-label="Next frame">
            <span aria-hidden="true">|▶</span>
          </button>

          <span className="player-time mono small">
            {timecode(current, fps)}
            <span className="muted"> / {duration ? timecode(duration, fps) : '—'}</span>
          </span>

          <div className="spacer" />

          <button className={`btn btn-sm${range.inPoint != null ? ' is-active' : ''}`} onClick={setIn} aria-pressed={range.inPoint != null}>In</button>
          <button className={`btn btn-sm${range.outPoint != null ? ' is-active' : ''}`} onClick={setOut} aria-pressed={range.outPoint != null}>Out</button>
          {(range.inPoint != null || range.outPoint != null) && (
            <>
              <span className="small muted mono">
                {range.inPoint != null && range.outPoint != null
                  ? fmtDuration(range.outPoint - range.inPoint)
                  : 'partial'}
              </span>
              <button className="btn btn-sm btn-ghost" onClick={clearRange} aria-label="Clear the selected range">Clear</button>
            </>
          )}

          <button className={`btn btn-sm${loop ? ' is-active' : ''}`} onClick={() => setLoop((x) => !x)} aria-pressed={loop}>Loop</button>

          <label className="player-speed small">
            <span className="sr-only">Playback speed</span>
            <select className="input player-select" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
            </select>
          </label>

          <button className="btn btn-icon" onClick={() => setMuted((x) => !x)} aria-label={muted ? 'Unmute' : 'Mute'} aria-pressed={muted}>
            <span aria-hidden="true">{muted || volume === 0 ? '🔇' : '🔊'}</span>
          </button>
          <label className="player-volume">
            <span className="sr-only">Volume</span>
            <input
              type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume}
              onChange={(e) => { setVolume(Number(e.target.value)); setMuted(false); }}
            />
          </label>

          <button className="btn btn-icon" onClick={toggleFullscreen} aria-label="Fullscreen"><span aria-hidden="true">⛶</span></button>
        </div>
      </div>

      {heavy && (
        <p className="small muted player-note">
          {Math.round(Number(file.size) / 1e9 * 10) / 10} GB original — seeking will buffer while it streams.
          {file.proxyStatus === 'queued' || file.proxyStatus === 'running'
            ? ' A streamable version is being prepared.'
            : ' Downloading is faster if you need to scrub.'}
        </p>
      )}
    </div>
  );
}
