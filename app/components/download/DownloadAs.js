'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Dialog from '@/app/components/ui/Dialog';
import Icon from '@/app/components/ui/Icon';
import { effectiveKind, fmtSize } from '@/lib/media';
import { decodeProbe, probedNow } from '@/lib/decode-probe';
import { probeEncoders, encodersNow, maxCanvasPixels, videoCodecsNow, canSaveToDisk } from '@/lib/download-probe';
import { timecode, frameAt, toRate, ASSUMED_RATE } from '@/lib/video-time';
import {
  downloadChoices, offersDownloadAs, formatById, recordedSize, proxyHeight, storedCoverFormat,
  imageDownloadName, proxyDownloadName, coverDownloadName, frameDownloadName, videoDownloadName,
} from '@/lib/download-formats';
import {
  hasVideoTargets, videoRowDetail, videoReasonText, etaSeconds, fmtMinutes, LONG_JOB_SECONDS, MEMORY_MAX_BYTES,
} from '@/lib/video-formats';
import './download.css';

/**
 * "Download as…": a file in another format or at another size.
 *
 *   image   Original, or a copy the browser makes — JPEG, PNG, and WebP or
 *           AVIF where this browser encodes them — at full size or a smaller
 *           long edge. Made in a worker (lib/download-client.js), with a
 *           Preparing… state that Cancel, Escape or closing stops.
 *   video   Original; an MP4 of H.264 and AAC at 4K, 1080p or 720p (never
 *           larger than the video) — its proxy when that is the size, else
 *           made in this browser (lib/video-client.js), with its size and
 *           time given before it starts and progress with the time left;
 *           a still frame as JPEG or PNG — the frame the player is showing
 *           when a player is open, else the cover.
 *
 * What is offered comes from lib/download-formats.js and lib/video-formats.js,
 * where the rules live. Three ways in, all this module's:
 *
 *   DownloadButtons   the Download button, split: the original as before,
 *                     and an arrow that opens this dialog (file page, Quick
 *                     Look, a share link's page)
 *   useDownloadAs     "Download as…" for the files view's context menu
 *   DownloadAsDialog  the dialog itself
 *
 * The original, the proxy and a cover saved as stored go through the
 * download routes (`base`, `?variant=`), which decide again on the server;
 * a copy the browser makes is saved from a blob — or, a video's copy too
 * large to hold, written as it is made to a file the person picks, where the
 * browser can (Chrome, Edge).
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

/**
 * A video's copies need its original looked at first — what it is, and what
 * this browser can make of it (lib/video-client.js) — which starts as the
 * dialog opens, in a worker that lives as long as the dialog does and makes
 * the copy asked for. `probe` is null while it runs; `reading` how much of
 * an original that can only be read whole has arrived. `renew()` lets the
 * session go and opens the original afresh — after a copy failed, so trying
 * again starts clean.
 */
function useVideoCopies(file, { enabled, guest }) {
  const [state, setState] = useState({ probe: null, reading: null });
  // The original as it was when the dialog opened: a listing that signs its
  // addresses again meanwhile does not stop a copy half made.
  const [source] = useState(() => ({ url: file.url, bytes: Number(file.size) > 0 ? Number(file.size) : null }));
  const [round, setRound] = useState(0);
  const session = useRef(null);
  const client = useRef(null);
  useEffect(() => {
    if (!enabled || !source.url) return undefined;
    let live = true;
    (async () => {
      try {
        const mod = await import('@/lib/video-client');
        if (!live) return;
        client.current = mod;
        // Someone signed in has the original signed again through the file's
        // record if it expires meanwhile; a share page signed it for six hours.
        const s = mod.videoSession({
          src: source.url,
          bytes: source.bytes,
          refreshUrl: guest ? null : `/api/files/${encodeURIComponent(file.id)}`,
        });
        session.current = s;
        const probe = await s.probe({ onProgress: (p) => { if (live && p.phase === 'read') setState((st) => ({ ...st, reading: p.fraction })); } });
        if (live) setState({ probe, reading: null });
      } catch (e) {
        if (live) setState({ probe: { ok: false, reason: e?.code || 'read' }, reading: null });
      }
    })();
    return () => {
      live = false;
      // Closing is cancelling: the worker, and all it read and made, goes.
      session.current?.close();
      session.current = null;
    };
  }, [enabled, source, file.id, guest, round]);
  const renew = useCallback(() => {
    setState({ probe: null, reading: null });
    setRound((n) => n + 1);
  }, []);
  return { ...state, session, client, renew };
}

const FORMAT_NOTES = {
  jpeg: 'The smallest for photos. No transparency.',
  png: 'Lossless, and keeps transparency. Larger files.',
  webp: 'Small, and keeps transparency. Opens in current browsers and apps.',
  avif: 'The smallest, and keeps transparency. Newer apps only.',
};
const PHASES = {
  fetch: 'Downloading the original…',
  read: 'Downloading the original…',
  cover: 'Downloading the cover…',
  frame: 'Reading the frame…',
  convert: 'Converting…',
  pick: 'Choose where to save the copy…',
  finish: 'Finishing…',
};

function Progress({ job }) {
  const pct = job.fraction == null ? null : Math.round(job.fraction * 100);
  const text = PHASES[job.phase] || 'Preparing…';
  const left = job.eta == null ? '' : job.eta < 60 ? ' · less than a minute left' : ` · about ${fmtMinutes(job.eta)} left`;
  return (
    <div className="dl-progress-wrap">
      <div
        className={`dl-progress${pct == null ? ' is-indeterminate' : ''}`}
        role="progressbar"
        aria-label={text}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={pct != null ? `${pct}%${left}` : undefined}
      >
        <span style={pct == null ? undefined : { width: `${pct}%` }} />
      </div>
      {/* Announced as each step starts, not at every percent: the bar carries those. */}
      <p className="small muted"><span aria-live="polite">{text}</span>{pct != null ? ` ${pct}%` : ''}{left}</p>
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
  // A video's copies: only where this browser has WebCodecs, the original is
  // at hand, and its size (if on record) leaves a copy to make.
  const [convert] = useState(() => kind === 'video' && videoCodecsNow());
  const [disk] = useState(() => kind === 'video' && canSaveToDisk());
  const copies = useVideoCopies(file, { enabled: convert && !!file.url && hasVideoTargets(file), guest });
  const choices = useMemo(
    () => downloadChoices(file, {
      probe, encoders, proxy: proxyOffer(file, proxy), still, maxPixels: maxCanvasPixels(),
      video: { convert, probe: copies.probe, disk },
    }),
    [file, probe, encoders, proxy, still, convert, copies.probe, disk],
  );
  const [pick, setPick] = useState(() => (kind === 'image'
    ? { format: 'jpeg', size: choices.sizes[0]?.id || 'full' }
    // The proxy when it is one of the sizes — there at once; else the original:
    // nothing that takes minutes is a keypress away.
    : { option: choices.sizes.find((r) => r.via === 'proxy')?.id || (choices.proxy ? 'proxy' : 'original') }));
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  const formId = useId();
  const formRef = useRef(null);
  const ctrl = useRef(null);
  const cancelRef = useRef(null);
  // Closing cancels: the fetch is aborted and the worker terminated.
  useEffect(() => () => ctrl.current?.abort(), []);

  const size = choices.sizes.find((s) => s.id === pick.size) || choices.sizes[0] || null;
  const fps = toRate(md.fps) || ASSUMED_RATE;
  const frameLabel = still?.from === 'frame'
    ? `The frame at ${timecode(frameAt(still.time, fps), { fps, tcStart: Number.isInteger(md.tcStart) ? md.tcStart : 0, dropFrame: md.dropFrame === true })}`
    : 'The cover picture';

  const videoOptions = kind === 'video' ? [
    { id: 'original', label: 'Original', detail: choices.original.detail },
    ...choices.sizes.map((r) => ({
      id: r.id, label: r.label, detail: videoRowDetail(r), disabled: r.state !== 'ready', checking: r.state === 'checking',
    })),
    choices.proxy && { id: 'proxy', label: choices.proxy.label, detail: choices.proxy.detail },
    ...(choices.still ? choices.still.formats.map((f) => ({ id: `still-${f.id}`, label: `Still frame · ${f.label}`, detail: frameLabel })) : []),
  ].filter(Boolean) : [];
  // A size the probe found this video cannot have (or this browser make) is
  // no longer picked; one still being looked at (the original opened again
  // after a copy failed) stays picked, and Download waits for it.
  const pickedOption = videoOptions.find((o) => o.id === pick.option);
  const pickGone = kind === 'video' && (!pickedOption || (pickedOption.disabled && !pickedOption.checking));
  useEffect(() => {
    if (pickGone && !job) setPick({ option: 'original' });
  }, [pickGone, job]);
  const copy = kind === 'video' ? choices.sizes.find((r) => r.id === pick.option) || null : null;
  const waiting = copy?.state === 'checking';

  // What it will be saved as — the copy's final name comes from what was made.
  const name = (() => {
    if (kind === 'image') {
      if (pick.format === 'original') return file.name;
      return imageDownloadName(file.name, { format: pick.format, size, source: recordedSize(file) });
    }
    if (copy) return videoDownloadName(file.name, copy.id);
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

  // `phase` is what shows while the converter itself loads: the job's first
  // step. `work` resolves { blob, filename } to save; { saved } for a copy
  // already written to a file on disk; { skip } for nothing to do after all.
  const run = async (work, phase = 'fetch') => {
    const c = new AbortController();
    ctrl.current = c;
    setError(null);
    setJob({ phase, fraction: null });
    // Everything but Cancel is disabled while it runs, which would drop the
    // focus: it goes to Cancel, and from there back to the opener on close.
    cancelRef.current?.focus({ preventScroll: true });
    try {
      const client = await import('@/lib/download-client');
      const progress = (p) => { if (!c.signal.aborted) setJob(p); };
      const out = await work(client, c.signal, progress);
      if (c.signal.aborted) return;
      if (out.skip) { setJob(null); return; }
      if (out.saved) { setJob(null); setSaved(out.saved); return; }
      client.saveBlob(out.blob, out.filename, { container: container() });
      onClose();
    } catch (e) {
      if (c.signal.aborted || e?.name === 'AbortError') return;
      setJob(null);
      setError(`${e?.message || 'This could not be prepared.'}`);
    } finally {
      if (ctrl.current === c) ctrl.current = null;
    }
  };

  /**
   * A video's copy, made here from the original (lib/video-client.js): into
   * memory and saved as a picture's copy is, or — too large to hold — into a
   * file the person picks first, where the browser can. The picker has to be
   * asked for in this click, before anything is waited on.
   */
  const makeCopy = (row) => {
    const session = copies.session.current;
    const video = copies.client.current;
    const plan = row.plan;
    if (!session || !video || !plan) return;
    const filename = videoDownloadName(file.name, row.id);
    const picked = plan.place === 'disk' ? video.pickSaveFile(filename) : Promise.resolve(null);
    // Answered below, once the job has started; not an unhandled rejection meanwhile.
    picked.catch(() => {});
    run(async (_client, signal, onProgress) => {
      const handle = await picked;
      if (plan.place === 'disk' && !handle) return { skip: true };
      const stop = () => { session.cancel(); };
      signal.addEventListener('abort', stop, { once: true });
      const pace = [];
      try {
        const out = await session.convert(plan, {
          handle,
          onProgress: (p) => {
            if (p.fraction != null) pace.push({ at: Date.now(), fraction: p.fraction });
            if (pace.length > 600) pace.splice(0, 300);
            onProgress({ phase: p.phase, fraction: p.fraction, eta: p.phase === 'convert' ? etaSeconds(pace) : null });
          },
        });
        return handle ? { saved: handle.name || filename } : { blob: out.blob, filename };
      } catch (e) {
        // A file begun and not finished is not the file: it goes.
        if (handle) await video.removeSaveFile(handle);
        // And the session with it — whatever stopped (an encoder, a reader
        // left behind) is let go, so another try starts clean.
        if (e?.name !== 'AbortError') copies.renew();
        throw e;
      } finally {
        signal.removeEventListener('abort', stop);
      }
    }, plan.place === 'disk' ? 'pick' : 'convert');
  };

  const start = (e) => {
    e?.preventDefault();
    if (job || saved) return;
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
    if (copy) {
      // At the proxy's size, the proxy: there already, and signed by the route.
      if (copy.via === 'proxy') { go(variant('proxy')); return; }
      if (copy.state === 'ready') makeCopy(copy);
      return;
    }
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

  // What a video's copy involves, said before it starts; or why one can't be made here.
  const plan = copy?.via === 'convert' ? copy.plan : null;
  const tooBig = kind === 'video' && choices.sizes.some((r) => r.state === 'off' && r.reason === 'size');
  const smaller = choices.sizes.find((r) => r.state === 'ready');
  // A long one is said so apart, where it is seen.
  const longJob = plan?.seconds > LONG_JOB_SECONDS
    ? `This may take ${fmtMinutes(plan.seconds)} or more. Keep this page open until it’s done.`
    : null;
  const videoNote = kind !== 'video' ? null : plan ? [
    `Made in this browser from the original${Number(file.size) > 0 ? ` (${fmtSize(file.size)})` : ''}, which is read in full${longJob ? '.' : ' — keep this page open until it’s done.'}`,
    plan.hdr ? 'This video is HDR: the copy is standard range (SDR), so it looks right on every screen.' : null,
    plan.place === 'disk' ? 'It’s too large to hold here, so you’ll choose where to save it and it’s written there as it’s made.' : null,
    'The copy leaves out the video’s details, location included.',
  ].filter(Boolean).join(' ') : tooBig
    ? `Copies over ${fmtSize(MEMORY_MAX_BYTES)} can only be made in Chrome or Edge, which write them straight to disk. Download the original${smaller ? `, or the ${smaller.label.replace(/ MP4.*$/, '')} copy,` : ''} instead.`
    : choices.videoReason && copies.probe && !choices.sizes.some((r) => r.via === 'convert')
      ? videoReasonText(choices.videoReason, file, copies.probe?.video?.codec)
      : null;

  return (
    <Dialog
      open
      onClose={cancel}
      title="Download as"
      footer={saved ? (
        // Focused as it appears: the Cancel it replaces had the focus.
        <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>Done</button>
      ) : (
        <>
          <button type="button" className="btn" onClick={cancel} ref={cancelRef}>Cancel</button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={busy || waiting}>
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
          <fieldset className="dl-group" disabled={busy || !!saved}>
            <legend className="small muted">What to download</legend>
            <div className="dl-options">
              {videoOptions.map((o) => (
                <label key={o.id} className={`dl-option${pick.option === o.id ? ' is-on' : ''}${o.disabled ? ' is-off' : ''}`}>
                  <input
                    type="radio"
                    name="option"
                    value={o.id}
                    checked={pick.option === o.id}
                    disabled={o.disabled}
                    onChange={() => { setPick({ option: o.id }); setError(null); }}
                  />
                  <span className="dl-option-label">{o.label}</span>
                  {o.detail ? <span className="dl-option-detail">{o.detail}</span> : null}
                </label>
              ))}
            </div>
            {copies.reading != null ? (
              <p className="small muted dl-note">Reading the original to see what copies it can have… {Math.round(copies.reading * 100)}%</p>
            ) : null}
            {videoNote ? <p className="small muted dl-note">{videoNote}</p> : null}
            {longJob ? <p className="small dl-note dl-warn">{longJob}</p> : null}
            {!choices.still && frame ? (
              <p className="small muted dl-note">Play the video, and a still of the frame on screen can be saved from here.</p>
            ) : null}
          </fieldset>
        )}
        {saved ? (
          <p className="small dl-done" role="status">Saved as <span className="dl-name-value">{saved}</span>, where you chose.</p>
        ) : (
          <p className="small muted dl-name">Saves as <span className="dl-name-value">{name}</span></p>
        )}
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
  // Whether a video's copies can be made here: known only in the browser,
  // so asked after the first render, which the server's must match.
  const [convert, setConvert] = useState(false);
  useEffect(() => { setConvert(videoCodecsNow()); }, []);
  const href = base || fileBase(file);
  const cls = `btn${primary ? ' btn-primary' : ''}${small ? ' btn-sm' : ''}`;
  const offered = offersDownloadAs(file, {
    probe, encoders, proxy: proxyOffer(file, proxy), still: stillOffer(file, frame), video: { convert },
  });
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
    probe, proxy: proxyOffer(f, null), still: stillOffer(f, null), video: { convert: videoCodecsNow() },
  }), [probe]);
  const close = useCallback(() => setFile(null), []);
  const element = file ? <DownloadAsDialog key={file.id} file={file} onClose={close} /> : null;
  return { offers, open: setFile, element };
}
