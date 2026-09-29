'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Dialog from '@/app/components/ui/Dialog';
import Icon from '@/app/components/ui/Icon';
import { effectiveKind } from '@/lib/media';
import { decodeProbe, probedNow } from '@/lib/decode-probe';
import { probeEncoders, encodersNow, maxCanvasPixels } from '@/lib/download-probe';
import { timecode, frameAt, toRate, ASSUMED_RATE } from '@/lib/video-time';
import {
  downloadChoices, offersDownloadAs, formatById, recordedSize, proxyHeight, storedCoverFormat,
  imageDownloadName, proxyDownloadName, coverDownloadName, frameDownloadName,
} from '@/lib/download-formats';
import './download.css';

/**
 * "Download as…": a file in another format or at another size.
 *
 *   image   Original, or a copy the browser makes — JPEG, PNG, and WebP or
 *           AVIF where this browser encodes them — at full size or a smaller
 *           long edge. Made in a worker (lib/download-client.js), with a
 *           Preparing… state that Cancel, Escape or closing stops.
 *   video   Original; its streamable 1080p copy when it has one; a still
 *           frame as JPEG or PNG — the frame the player is showing when a
 *           player is open, else the cover.
 *
 * What is offered comes from lib/download-formats.js, the one place the
 * rules live. Three ways in, all this module's:
 *
 *   DownloadButtons   the Download button, split: the original as before,
 *                     and an arrow that opens this dialog (file page, Quick
 *                     Look, a share link's page)
 *   useDownloadAs     "Download as…" for the files view's context menu
 *   DownloadAsDialog  the dialog itself
 *
 * The original, the proxy and a cover saved as stored go through the
 * download routes (`base`, `?variant=`), which decide again on the server;
 * a copy the browser makes is saved from a blob.
 */

const fileBase = (file) => `/api/files/${file.id}/download`;
const needsDecodeProbe = (file) => /heic|heif|tiff?/i.test(`${file?.mime || ''} ${file?.name || ''}`);
const hasCover = (file) => !!(file?.posterUrl || file?.thumbnailUrl);

/** What this browser decodes and encodes, as the choices need it: asked once, answered as it lands. */
function useAbilities(file) {
  const kind = effectiveKind(file);
  const [probe, setProbe] = useState(probedNow);
  const [encoders, setEncoders] = useState(encodersNow);
  const wantProbe = kind === 'image' && needsDecodeProbe(file);
  useEffect(() => {
    let live = true;
    if (wantProbe) decodeProbe().then((p) => { if (live) setProbe(p); }, () => {});
    if (kind === 'image') probeEncoders().then((e) => { if (live) setEncoders(e); }, () => {});
    return () => { live = false; };
  }, [kind, wantProbe]);
  return { probe, encoders };
}

/** The player's <video>: from a function (the file page, Quick Look), or a selector (a share page, rendered on the server). */
function playerVideo(frame) {
  try {
    const el = typeof frame === 'function' ? frame() : typeof frame === 'string' && typeof document !== 'undefined' ? document.querySelector(frame) : null;
    return el && el.tagName === 'VIDEO' ? el : null;
  } catch {
    return null;
  }
}

/**
 * Where a still would come from, decided as the dialog opens: the frame on a
 * player that has one on screen, else the cover picture, else nowhere.
 */
function stillSource(file, frame) {
  const v = playerVideo(frame);
  if (v && v.readyState >= 2 && v.videoWidth > 0 && /^https?:/.test(v.currentSrc || '')) {
    return { from: 'frame', src: v.currentSrc, time: v.currentTime || 0, video: v };
  }
  if (file?.posterUrl) return { from: 'cover', src: file.posterUrl, field: 'posterUrl' };
  if (file?.thumbnailUrl) return { from: 'cover', src: file.thumbnailUrl, field: 'thumbnailUrl' };
  return null;
}

/** Whether a video file has a still to offer before the dialog is open: a cover, or a player it may have a frame on. */
const stillOffer = (file, frame) => (hasCover(file) || frame ? { from: hasCover(file) ? 'cover' : 'frame' } : null);

/** The proxy as the choices want it: `proxy` when the page watches the job, else the row's signed proxyUrl. */
const proxyOffer = (file, proxy) => proxy || { available: !!file?.proxyUrl };

const FORMAT_NOTES = {
  jpeg: 'The smallest for photos. No transparency.',
  png: 'Lossless, and keeps transparency. Larger files.',
  webp: 'Small, and keeps transparency. Opens in current browsers and apps.',
  avif: 'The smallest, and keeps transparency. Newer apps only.',
};
const PHASES = {
  fetch: 'Downloading the original…',
  cover: 'Downloading the cover…',
  frame: 'Reading the frame…',
  convert: 'Converting…',
};

function Progress({ job }) {
  const pct = job.fraction == null ? null : Math.round(job.fraction * 100);
  const text = PHASES[job.phase] || 'Preparing…';
  return (
    <div className="dl-progress-wrap">
      <div
        className={`dl-progress${pct == null ? ' is-indeterminate' : ''}`}
        role="progressbar"
        aria-label={text}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
      >
        <span style={pct == null ? undefined : { width: `${pct}%` }} />
      </div>
      {/* Announced as each step starts, not at every percent: the bar carries those. */}
      <p className="small muted"><span aria-live="polite">{text}</span>{pct != null ? ` ${pct}%` : ''}</p>
    </div>
  );
}

/** Click a link to `href` from inside `container` — the open dialog, since behind a modal one the page is inert. */
function follow(href, container) {
  const a = document.createElement('a');
  a.href = href;
  a.rel = 'noopener';
  (container || document.body).appendChild(a);
  a.click();
  a.remove();
}

/**
 * The dialog. Mounted only while open (unmounting is closing, and cancels
 * anything being prepared). `base` is the download route: the file's, or a
 * share link's. `frame` finds the player's <video>; `proxy` is { available,
 * size } when the page watches the proxy job; `guest` for a share link,
 * whose addresses cannot be signed again from here.
 */
export default function DownloadAsDialog({ file, base = null, onClose, frame = null, proxy = null, guest = false }) {
  const href = base || fileBase(file);
  const kind = effectiveKind(file);
  const md = file.metadata || {};
  const { probe, encoders } = useAbilities(file);
  // Decided once, as it opens; the player is paused so the frame is the one
  // that was on screen.
  const [still] = useState(() => (kind === 'video' ? stillSource(file, frame) : null));
  useEffect(() => { try { still?.video?.pause(); } catch { /* not ours to fail on */ } }, [still]);
  const choices = useMemo(
    () => downloadChoices(file, { probe, encoders, proxy: proxyOffer(file, proxy), still, maxPixels: maxCanvasPixels() }),
    [file, probe, encoders, proxy, still],
  );
  const [pick, setPick] = useState(() => (kind === 'image'
    ? { format: 'jpeg', size: choices.sizes[0]?.id || 'full' }
    : { option: choices.proxy ? 'proxy' : choices.still ? 'still-jpeg' : 'original' }));
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const formId = useId();
  const formRef = useRef(null);
  const ctrl = useRef(null);
  // Closing cancels: the fetch is aborted and the worker terminated.
  useEffect(() => () => ctrl.current?.abort(), []);

  const size = choices.sizes.find((s) => s.id === pick.size) || choices.sizes[0] || null;
  const fps = toRate(md.fps) || ASSUMED_RATE;
  const frameLabel = still?.from === 'frame'
    ? `The frame at ${timecode(frameAt(still.time, fps), { fps, tcStart: Number.isInteger(md.tcStart) ? md.tcStart : 0, dropFrame: md.dropFrame === true })}`
    : 'The cover picture';

  const videoOptions = kind === 'video' ? [
    { id: 'original', label: 'Original', detail: choices.original.detail },
    choices.proxy && { id: 'proxy', label: choices.proxy.label, detail: choices.proxy.detail },
    ...(choices.still ? choices.still.formats.map((f) => ({ id: `still-${f.id}`, label: `Still frame · ${f.label}`, detail: frameLabel })) : []),
  ].filter(Boolean) : [];

  // What it will be saved as — the copy's final name comes from what was made.
  const name = (() => {
    if (kind === 'image') {
      if (pick.format === 'original') return file.name;
      return imageDownloadName(file.name, { format: pick.format, size, source: recordedSize(file) });
    }
    if (pick.option === 'proxy') return proxyDownloadName(file.name, { height: proxyHeight(file) });
    if (pick.option?.startsWith('still-')) {
      const f = pick.option.slice(6);
      return still?.from === 'frame'
        ? frameDownloadName(file.name, { format: f, seconds: still.time, metadata: md })
        : coverDownloadName(file.name, { ext: formatById(f)?.ext });
    }
    return file.name;
  })();

  const container = () => formRef.current?.closest('dialog') || null;
  const go = (url) => { follow(url, container()); onClose(); };
  const variant = (v) => `${href}${href.includes('?') ? '&' : '?'}variant=${v}`;

  // A signed address that expired while the page sat open is signed again —
  // for someone signed in; a share page is signed for six hours at load.
  const refresh = useCallback((field) => (guest ? null : async () => {
    const r = await fetch(`/api/files/${encodeURIComponent(file.id)}`, { cache: 'no-store' });
    return r.ok ? (await r.json())?.file?.[field] || null : null;
  }), [guest, file.id]);

  // `phase` is what shows while the converter itself loads: the job's first step.
  const run = async (work, phase = 'fetch') => {
    const c = new AbortController();
    ctrl.current = c;
    setError(null);
    setJob({ phase, fraction: null });
    try {
      const client = await import('@/lib/download-client');
      const progress = (p) => { if (!c.signal.aborted) setJob(p); };
      const { blob, filename } = await work(client, c.signal, progress);
      if (c.signal.aborted) return;
      client.saveBlob(blob, filename, { container: container() });
      onClose();
    } catch (e) {
      if (c.signal.aborted || e?.name === 'AbortError') return;
      setJob(null);
      setError(`${e?.message || 'This could not be prepared.'}`);
    } finally {
      if (ctrl.current === c) ctrl.current = null;
    }
  };

  const start = (e) => {
    e?.preventDefault();
    if (job) return;
    if (kind === 'image') {
      if (pick.format === 'original') { go(href); return; }
      const format = formatById(pick.format);
      run(async (client, signal, onProgress) => {
        const out = await client.convertImage({ src: file.url, format, longEdge: size?.longEdge ?? null, signal, onProgress, refresh: refresh('url') });
        return { blob: out.blob, filename: imageDownloadName(file.name, { format, size: out, source: out.source }) };
      });
      return;
    }
    if (pick.option === 'original') { go(href); return; }
    if (pick.option === 'proxy') { go(variant('proxy')); return; }
    if (pick.option?.startsWith('still-') && still) {
      const format = formatById(pick.option.slice(6));
      // The cover is already a picture in this format: saved as it is.
      if (still.from === 'cover' && storedCoverFormat(still.src) === format.id) { go(variant('poster')); return; }
      run(async (client, signal, onProgress) => {
        if (still.from === 'frame') {
          const out = await client.frameStill({ src: still.src, time: still.time, format, signal, onProgress });
          return { blob: out.blob, filename: frameDownloadName(file.name, { format, seconds: still.time, metadata: md }) };
        }
        const out = await client.convertImage({
          src: still.src, format, signal, refresh: refresh(still.field),
          onProgress: (p) => onProgress(p.phase === 'fetch' ? { ...p, phase: 'cover' } : p),
        });
        return { blob: out.blob, filename: coverDownloadName(file.name, { ext: format.ext }) };
      }, still.from === 'frame' ? 'frame' : 'cover');
    }
  };

  const cancel = () => { ctrl.current?.abort(); onClose(); };
  const busy = !!job;
  const note = kind !== 'image' ? null : pick.format === 'original'
    ? `${choices.original.detail ? `${choices.original.detail}, ` : ''}as it was uploaded.`
    : `${FORMAT_NOTES[pick.format] || ''} The copy leaves out the camera’s details, location included.`;

  return (
    <Dialog
      open
      onClose={cancel}
      title="Download as"
      footer={(
        <>
          <button type="button" className="btn" onClick={cancel}>Cancel</button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={busy}>
            {busy ? 'Preparing…' : 'Download'}
          </button>
        </>
      )}
    >
      <p className="dl-file" title={file.name}>{file.name}</p>
      <form id={formId} ref={formRef} className="dl-form" onSubmit={start}>
        {kind === 'image' ? (
          <>
            <fieldset className="dl-group" disabled={busy}>
              <legend className="small muted">Format</legend>
              <div className="dl-segments">
                {[{ id: 'original', label: 'Original' }, ...choices.formats].map((f) => (
                  <label key={f.id} className={`dl-segment${pick.format === f.id ? ' is-on' : ''}`}>
                    <input
                      type="radio"
                      name="format"
                      value={f.id}
                      checked={pick.format === f.id}
                      onChange={() => { setPick((p) => ({ ...p, format: f.id })); setError(null); }}
                    />
                    <span>{f.label}</span>
                  </label>
                ))}
              </div>
              <p className="small muted dl-detail">{note}</p>
            </fieldset>
            <fieldset className="dl-group" disabled={busy || pick.format === 'original'}>
              <legend className="small muted">Size</legend>
              <div className="dl-options">
                {choices.sizes.map((s) => (
                  <label key={s.id} className={`dl-option${pick.size === s.id && pick.format !== 'original' ? ' is-on' : ''}`}>
                    <input
                      type="radio"
                      name="size"
                      value={s.id}
                      checked={pick.size === s.id}
                      onChange={() => { setPick((p) => ({ ...p, size: s.id })); setError(null); }}
                    />
                    <span className="dl-option-label">{s.label}</span>
                    {s.width ? <span className="dl-option-detail">{s.width} × {s.height}</span> : null}
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        ) : (
          <fieldset className="dl-group" disabled={busy}>
            <legend className="small muted">What to download</legend>
            <div className="dl-options">
              {videoOptions.map((o) => (
                <label key={o.id} className={`dl-option${pick.option === o.id ? ' is-on' : ''}`}>
                  <input
                    type="radio"
                    name="option"
                    value={o.id}
                    checked={pick.option === o.id}
                    onChange={() => { setPick({ option: o.id }); setError(null); }}
                  />
                  <span className="dl-option-label">{o.label}</span>
                  {o.detail ? <span className="dl-option-detail">{o.detail}</span> : null}
                </label>
              ))}
            </div>
            {!choices.still && frame ? (
              <p className="small muted dl-note">Play the video, and a still of the frame on screen can be saved from here.</p>
            ) : null}
          </fieldset>
        )}
        <p className="small muted dl-name">Saves as <span className="dl-name-value">{name}</span></p>
        {job && <Progress job={job} />}
        {error && <p className="small dl-error" role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}

/**
 * Download, split: the original exactly as before, and — when there is more
 * to offer — an arrow beside it that opens "Download as". Class names follow
 * the button it replaces: `primary` (a share page), `small` (Quick Look).
 */
export function DownloadButtons({ file, base = null, primary = false, small = false, frame = null, proxy = null, guest = false }) {
  const [open, setOpen] = useState(false);
  const { probe, encoders } = useAbilities(file);
  const href = base || fileBase(file);
  const cls = `btn${primary ? ' btn-primary' : ''}${small ? ' btn-sm' : ''}`;
  const offered = offersDownloadAs(file, { probe, encoders, proxy: proxyOffer(file, proxy), still: stillOffer(file, frame) });
  if (!offered) return <a className={cls} href={href}>Download</a>;
  return (
    <span className="dl-split">
      <a className={cls} href={href}>Download</a>
      <button
        type="button"
        className={`${cls} btn-icon dl-more`}
        aria-haspopup="dialog"
        aria-label="Download as…"
        title="Download as…"
        onClick={() => setOpen(true)}
      >
        <Icon name="chevron-down" size={small ? 14 : 16} />
      </button>
      {open && <DownloadAsDialog file={file} base={href} frame={frame} proxy={proxy} guest={guest} onClose={() => setOpen(false)} />}
    </span>
  );
}

/**
 * "Download as…" for a menu: `offers(file)` says whether to show the item,
 * `open(file)` opens the dialog, and `element` is where it renders.
 */
export function useDownloadAs() {
  const [file, setFile] = useState(null);
  const [probe, setProbe] = useState(probedNow);
  // Asked early, so a HEIC's item is there by the first right-click, and a
  // dialog opens with WebP already known.
  useEffect(() => {
    let live = true;
    decodeProbe().then((p) => { if (live) setProbe(p); }, () => {});
    probeEncoders().catch(() => {});
    return () => { live = false; };
  }, []);
  const offers = useCallback((f) => !!f && offersDownloadAs(f, {
    probe, proxy: proxyOffer(f, null), still: stillOffer(f, null),
  }), [probe]);
  const close = useCallback(() => setFile(null), []);
  const element = file ? <DownloadAsDialog key={file.id} file={file} onClose={close} /> : null;
  return { offers, open: setFile, element };
}
