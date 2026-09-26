'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  ASSUMED_RATE, toRate, rateLabel, frameAt, secondsOfFrame, frameCount, clampFrame, timecode,
  timeFromPointer, percentOf, bufferedSpans, shuttleRate, seekToDigit,
} from '@/lib/video-time';
import { frameIndexAt, framePosition, layoutFromMetadata } from '@/lib/filmstrip';
import { pendingSeek } from '@/lib/pending-seek';
import useContainedRect from '@/app/components/review/useContainedRect';

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
 *   C           comment on this frame (when the page offers review)
 *
 * FRAMES. The player knows which frame is on screen, not just a time: it
 * follows the presented frame with requestVideoFrameCallback, whose
 * `mediaTime` is the timestamp of the frame the compositor actually showed
 * (timeupdate fires four times a second and says nothing about frames), and
 * falls back to timeupdate/seeked where that API is missing. The rate is the
 * file's exact one when it was probed (lib/mp4-probe.js), so the timecode
 * reads as the NLE's does, start timecode and drop-frame included; without
 * one it assumes 30 and says so on hover. Seeks land mid-frame
 * (secondsOfFrame), the one instant Chrome and Safari agree on.
 *
 * REVIEW. `markers` are comments on the scrub bar (click one to land on its
 * frame), `overlay` renders inside the stage on the picture's own rectangle —
 * so a drawing survives fullscreen and letterboxing — and a ref exposes
 * seekToFrame, pause and hold for the review panel. hold() is what a comment
 * about to be pinned to "this frame" calls: until the first seek or play the
 * stage shows the poster, a frame from mid-clip, not the frame the label
 * reads, so it loads and shows that frame first. All optional; the share
 * page passes none of them.
 *
 * SEEKS BEFORE LOAD. A seek asked for before the source has loaded (a ?t=
 * link, a comment marker, a frame step on a master still waiting for play)
 * is kept and made when the metadata arrives — the latest one, not the deep
 * link's (lib/pending-seek.js).
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

const VideoPlayer = forwardRef(function VideoPlayer({
  file, startAt = 0, onRangeChange, markers = null, onMarkerClick, onFrameChange, overlay = null, onComment,
}, ref) {
  const video = useRef(null);
  const bar = useRef(null);
  const shell = useRef(null);
  const stage = useRef(null);
  const shuttle = useRef({ presses: 0, direction: 1 });
  // Seeks asked for before the source loads, and whether the stage has shown
  // anything but the poster yet. Made once, from the first render's startAt.
  const intent = useRef(null);
  if (!intent.current) intent.current = pendingSeek(startAt);

  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(Number(startAt) || 0);
  const [duration, setDuration] = useState(Number(file?.metadata?.duration) || 0);
  const [buffered, setBuffered] = useState([]);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(false);
  // The selected range, in frames: In is the first frame of it and Out the
  // last, both inclusive, as an editor marks them.
  const [range, setRange] = useState({ inFrame: null, outFrame: null });
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
  // The player's own poster — the grid thumbnail's frame at up to 1920px
  // (lib/poster.js) — where the file has one. The grid-sized thumbnail is
  // the fallback: on a stage this wide it is enlarged, but it is the picture.
  const poster = file?.posterUrl || file?.thumbnailUrl || null;
  useEffect(() => {
    if (ratio || !poster) return undefined;
    let live = true;
    const img = new Image();
    img.onload = () => {
      if (live && img.naturalWidth && img.naturalHeight) setRatio((r) => r || img.naturalWidth / img.naturalHeight);
    };
    img.src = poster;
    return () => { live = false; };
  }, [ratio, poster]);

  const proxy = file?.proxyUrl || null;
  const src = proxy || file?.url || null;
  const heavy = !proxy && Number(file?.size) > HEAVY_BYTES;
  const strip = useMemo(() => layoutFromMetadata(file?.metadata), [file?.metadata]);
  const stripUrl = file?.filmstripUrl || null;

  // The frame model: the exact rate the container recorded, its start
  // timecode and drop-frame flag — or the assumed 30, marked as a guess.
  const md = file?.metadata || {};
  const known = toRate(md.fps);
  const fpsKey = known ? `${known.num}/${known.den}` : '';
  const fps = useMemo(() => toRate(fpsKey) || ASSUMED_RATE, [fpsKey]);
  const model = useMemo(
    () => ({ fps, tcStart: Number.isInteger(md.tcStart) ? md.tcStart : 0, dropFrame: md.dropFrame === true }),
    [fps, md.tcStart, md.dropFrame],
  );
  const total = frameCount({ frames: md.frames, duration, fps });
  const [frame, setFrame] = useState(() => frameAt(Number(startAt) || 0, fps));
  const frameRef = useRef(frame);
  frameRef.current = frame;

  // The picture's own size, for placing the overlay on it: recorded at
  // upload, then the element's once its metadata arrives.
  const [picture, setPicture] = useState({ w: Number(md.width) || 0, h: Number(md.height) || 0 });
  const rect = useContainedRect(stage, picture.w, picture.h);

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

  // Seconds of the range, for painting it and looping it: from the start of
  // the In frame to the end of the Out frame.
  const inPoint = range.inFrame != null ? (range.inFrame * fps.den) / fps.num : null;
  const outPoint = range.outFrame != null ? ((range.outFrame + 1) * fps.den) / fps.num : null;

  useEffect(() => {
    onRangeChange?.({ ...range, inPoint, outPoint });
  }, [range, inPoint, outPoint, onRangeChange]);

  // Follow the frame on screen. requestVideoFrameCallback fires once per
  // presented frame, with that frame's timestamp — during playback, and once
  // after each seek while paused. Where it is missing (older Firefox), the
  // media events are the best there is.
  useEffect(() => {
    const v = video.current;
    if (!v) return undefined;
    // Until the source loads (a master waits for play) its currentTime is 0
    // whatever was asked for; the label shows where playback will start.
    setFrame(frameAt(v.readyState > 0 ? v.currentTime : intent.current.pending() ?? 0, fps));
    if (typeof v.requestVideoFrameCallback === 'function') {
      let live = true;
      let handle = 0;
      const tick = (_now, meta) => {
        if (!live) return;
        setFrame(frameAt(meta.mediaTime, fps));
        handle = v.requestVideoFrameCallback(tick);
      };
      handle = v.requestVideoFrameCallback(tick);
      return () => { live = false; v.cancelVideoFrameCallback?.(handle); };
    }
    const sync = () => setFrame(frameAt(v.currentTime, fps));
    v.addEventListener('timeupdate', sync);
    v.addEventListener('seeked', sync);
    return () => {
      v.removeEventListener('timeupdate', sync);
      v.removeEventListener('seeked', sync);
    };
  }, [fps, src]);

  // Tell the page which frame is up. Every frame while paused or scrubbing;
  // at most five times a second while playing, so a comment list beside the
  // player is not re-rendered at 60Hz for a label nobody reads mid-play.
  const lastEmit = useRef(0);
  useEffect(() => {
    if (!onFrameChange) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (playing && now - lastEmit.current < 200) return;
    lastEmit.current = now;
    onFrameChange(frame, { playing });
  }, [frame, playing, onFrameChange]);

  const seek = useCallback((to) => {
    const v = video.current;
    if (!v || !Number.isFinite(to)) return;
    const length = v.duration || duration;
    const clamped = Math.min(Math.max(0, to), length || to);
    intent.current.seek(v, clamped);
    setCurrent(clamped);
    // No frame will be presented to say where this landed until the source
    // loads, so the label moves now.
    if (v.readyState === 0) setFrame(frameAt(clamped, fps));
  }, [duration, fps]);

  // Where the player is, or will be once it has loaded: the base for a
  // relative seek, which from a deep link not yet loaded is the link's time,
  // not the element's 0.
  const position = useCallback(() => {
    const v = video.current;
    if (!v) return 0;
    return v.readyState > 0 ? v.currentTime : intent.current.pending() ?? 0;
  }, []);

  /** Land on frame `n`, mid-frame, and show it — loading the source if it has not been yet. */
  const seekToFrame = useCallback((n) => {
    const f = clampFrame(n, total);
    setStarted(true);
    setFrame(f);
    seek(secondsOfFrame(f, fps));
  }, [seek, total, fps]);

  const step = useCallback((dir) => {
    video.current?.pause();
    seekToFrame(frameRef.current + dir);
  }, [seekToFrame]);

  /**
   * Pause, on a picture that is the frame the label reads. Until the first
   * seek or play the stage shows the poster (from mid-clip), and before the
   * source loads nothing else is there to show — so the frame is loaded and
   * shown, as picking up a drawing tool does. Once it is, this only pauses.
   */
  const hold = useCallback(() => {
    video.current?.pause();
    if (!intent.current.presented()) seekToFrame(frameRef.current);
  }, [seekToFrame]);

  useImperativeHandle(ref, () => ({
    seekToFrame: (n) => { video.current?.pause(); seekToFrame(n); },
    pause: () => video.current?.pause(),
    hold,
    frame: () => frameRef.current,
  }), [seekToFrame, hold]);

  const togglePlay = useCallback(() => {
    const v = video.current;
    if (!v) return;
    setStarted(true);
    if (v.paused) {
      shuttle.current = { presses: 0, direction: 1 };
      v.playbackRate = speed;
      // A rejected play() is normal — autoplay policy, or a source that will
      // not decode. Swallowing it silently leaves a dead button, so it is
      // reported. Except an AbortError: that is a pause (a seek to a
      // comment, a drawing tool picked up) overtaking the play, as asked.
      v.play().catch((e) => { if (e?.name !== 'AbortError') setError(e?.message || 'This video could not be played.'); });
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
      seek(position() - rate * 0.5);
    } else {
      v.playbackRate = rate;
      setSpeed(rate);
      v.play().catch(() => {});
    }
  }, [seek, position]);

  // Out is never at or before In: a zero-length or inverted range reads as a
  // bug everywhere downstream, so the other end is nudged instead.
  const lastFrame = Number.isFinite(total) ? total - 1 : Infinity;
  const tidy = useCallback(({ inFrame, outFrame }) => {
    if (inFrame == null || outFrame == null || outFrame > inFrame) return { inFrame, outFrame };
    const out = Math.min(inFrame + 1, lastFrame);
    return out > inFrame ? { inFrame, outFrame: out } : { inFrame: Math.max(0, out - 1), outFrame: out };
  }, [lastFrame]);
  const setIn = useCallback(() => setRange((r) => tidy({ ...r, inFrame: frameRef.current })), [tidy]);
  const setOut = useCallback(() => setRange((r) => tidy({ ...r, outFrame: frameRef.current })), [tidy]);
  const clearRange = useCallback(() => setRange({ inFrame: null, outFrame: null }), []);
  const comment = useCallback(() => {
    if (!onComment) return;
    hold();
    onComment({ frame: frameRef.current });
  }, [onComment, hold]);

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
      ',': () => step(-1),
      '.': () => step(1),
      ArrowLeft: () => seek(position() - big),
      ArrowRight: () => seek(position() + big),
      ArrowUp: () => setVolume((x) => Math.min(1, x + 0.1)),
      ArrowDown: () => setVolume((x) => Math.max(0, x - 0.1)),
      Home: () => seek(0),
      End: () => seek(duration),
      i: setIn, I: setIn, o: setOut, O: setOut,
      X: clearRange,
      m: () => setMuted((x) => !x), M: () => setMuted((x) => !x),
      f: toggleFullscreen, F: toggleFullscreen,
      ...(onComment ? { c: comment, C: comment } : {}),
    };
    if (keys[e.key]) { e.preventDefault(); keys[e.key](); return; }
    if (/^[0-9]$/.test(e.key)) {
      const to = seekToDigit(Number(e.key), duration);
      if (to != null) { e.preventDefault(); seek(to); }
    }
  }, [togglePlay, doShuttle, seek, position, step, duration, setIn, setOut, clearRange, toggleFullscreen, onComment, comment]);

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
  const tc = (f) => timecode(f, model);
  const rateNote = known ? `${rateLabel(fps)} fps` : 'Frame rate unknown — timecodes are approximate';
  const frameTime = (f) => (f * fps.den) / fps.num;
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
      <div className="player-stage" ref={stage} style={{ '--ratio': ratio || 16 / 9 }}>
        <video
          ref={video}
          src={src}
          poster={poster || undefined}
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
            if (e.target.videoWidth && e.target.videoHeight) {
              setRatio(e.target.videoWidth / e.target.videoHeight);
              setPicture({ w: e.target.videoWidth, h: e.target.videoHeight });
            }
            // The seek asked for while there was nothing to seek — the ?t=
            // deep link, or anything since that overtook it — made now that
            // there is.
            intent.current.loaded(e.target);
          }}
          // Either one ends the poster: from here the stage shows frames.
          onSeeking={() => intent.current.shown()}
          onTimeUpdate={(e) => {
            const t = e.target.currentTime;
            setCurrent(t);
            // Loop the selected range rather than the whole clip when one is
            // set: that is what a range is for.
            if (loop && inPoint != null && outPoint != null && t >= outPoint) {
              seek(secondsOfFrame(range.inFrame, fps));
            }
          }}
          onProgress={(e) => setBuffered(bufferedSpans(e.target.buffered, e.target.duration || duration))}
          onPlay={() => { intent.current.shown(); setPlaying(true); }}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onVolumeChange={(e) => { setVolume(e.target.volume); setMuted(e.target.muted); }}
          onError={() => setError('This browser cannot decode this video. Download it to view.')}
          loop={loop && inPoint == null}
        />

        {/* On the picture's own rectangle, not the stage's: the stage
            letterboxes, and a drawing belongs to the frame. Inside the
            stage, so it goes fullscreen with it. */}
        {overlay && (
          <div className="player-overlay" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
            {overlay({ frame, playing, width: picture.w, height: picture.h })}
          </div>
        )}

        {!started && !proxy && (
          <button className="player-bigplay" onClick={togglePlay} aria-label="Play">
            <span aria-hidden="true">▶</span>
          </button>
        )}
      </div>

      {error && <p className="player-error small">{error}</p>}

      <div className="player-bar">
        {markers?.length > 0 && duration > 0 && (
          // Comments on the timeline, above the scrub bar rather than on it
          // so a click lands exactly on a comment's frame instead of
          // starting a scrub a few pixels to one side.
          <div className="player-marks" role="group" aria-label="Comments on the timeline">
            {markers.map((m) => {
              const left = percentOf(frameTime(m.frameIn), duration);
              const right = m.frameOut != null ? percentOf(frameTime(m.frameOut + 1), duration) : null;
              return (
                <button
                  key={m.id}
                  type="button"
                  className={`player-mark is-comment${m.active ? ' is-selected' : ''}${right != null ? ' is-range' : ''}`}
                  style={{ left: `${left}%`, ...(right != null ? { width: `${Math.max(0, right - left)}%` } : null) }}
                  title={m.label}
                  aria-label={m.label}
                  onClick={() => { video.current?.pause(); seekToFrame(m.frameIn); onMarkerClick?.(m.id); }}
                />
              );
            })}
          </div>
        )}
        <div
          className="player-scrub"
          ref={bar}
          role="slider"
          tabIndex={-1}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration) || 0}
          aria-valuenow={Math.round(current)}
          aria-valuetext={tc(frame)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setHover(null)}
        >
          {spans.map((s, i) => (
            <span key={i} className="player-buffered" style={{ left: `${s.left}%`, width: `${s.width}%` }} />
          ))}
          {inPoint != null && outPoint != null && (
            <span
              className="player-range"
              style={{
                left: `${percentOf(inPoint, duration)}%`,
                width: `${percentOf(outPoint, duration) - percentOf(inPoint, duration)}%`,
              }}
            />
          )}
          <span className="player-played" style={{ width: `${played}%` }} />
          <span className="player-head" style={{ left: `${played}%` }} />
          {inPoint != null && <span className="player-mark in" style={{ left: `${percentOf(inPoint, duration)}%` }} />}
          {outPoint != null && <span className="player-mark out" style={{ left: `${percentOf(outPoint, duration)}%` }} />}

          {hoverPct != null && (
            <div className="player-hover" style={{ left: `${hoverPct}%` }}>
              {stripStyle && <div className="player-hover-frame" style={stripStyle} />}
              <span className="player-hover-time mono">{tc(frameAt(hover, fps))}</span>
            </div>
          )}
        </div>

        <div className="player-controls">
          <button className="btn btn-icon" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} aria-pressed={playing}>
            <span aria-hidden="true">{playing ? '❚❚' : '▶'}</span>
          </button>
          <button className="btn btn-icon" onClick={() => step(-1)} aria-label="Previous frame">
            <span aria-hidden="true">◀|</span>
          </button>
          <button className="btn btn-icon" onClick={() => step(1)} aria-label="Next frame">
            <span aria-hidden="true">|▶</span>
          </button>

          <span className="player-time mono small" title={rateNote}>
            {tc(frame)}
            <span className="muted"> / {Number.isFinite(total) ? timecode(total, { fps, dropFrame: model.dropFrame }) : '—'}</span>
          </span>

          <div className="spacer" />

          <button className={`btn btn-sm${range.inFrame != null ? ' is-active' : ''}`} onClick={setIn} aria-pressed={range.inFrame != null}>In</button>
          <button className={`btn btn-sm${range.outFrame != null ? ' is-active' : ''}`} onClick={setOut} aria-pressed={range.outFrame != null}>Out</button>
          {(range.inFrame != null || range.outFrame != null) && (
            <>
              <span className="small muted mono" title="Length of the range">
                {range.inFrame != null && range.outFrame != null
                  ? timecode(range.outFrame - range.inFrame + 1, { fps, dropFrame: model.dropFrame })
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
});

export default VideoPlayer;
