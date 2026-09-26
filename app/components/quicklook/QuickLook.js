'use client';

import { useEffect, useId, useRef } from 'react';
import { effectiveKind, drawableKind, fmtSize, fmtDuration } from '@/lib/media';
import { thumbSources } from '@/lib/renditions';
import { probedNow, decodeProbe } from '@/lib/decode-probe';
import { positionLabel } from '@/lib/quicklook';
import { previewWanted } from '@/lib/preview-wanted';
import { preloaded } from '@/lib/original-preload';
import { parseKey } from '@/lib/selection';
import { modKey } from '@/lib/keys';
import ProgressiveImage from '@/app/components/media/ProgressiveImage';
import useQuickLook from './useQuickLook';
import useOpenPrefetch from '@/app/files/useOpenPrefetch';
import '@/app/components/review/review.css';
import './quicklook.css';
import Icon from '@/app/components/ui/Icon';

function mark(name, key) {
  try { performance.mark(`onyx:ql:${name}`, { detail: { key } }); } catch {}
}

/** The picture a tile is showing for `id`, if it is on screen and loaded: the cheapest first layer there is. */
function tilePicture(id) {
  if (typeof document === 'undefined') return null;
  const img = document.querySelector(`.files-pane [data-file-id="${CSS.escape(String(id))}"] img`);
  return img && img.complete && img.naturalWidth ? img.currentSrc || img.src : null;
}

const FOCUSABLE = 'button:not([disabled]), a[href], video[controls], audio[controls], [tabindex]:not([tabindex="-1"])';
// A control that answers its own keys: Return and Space press a button or
// follow a link; a player or a field takes the arrows too.
const CONTROL = 'button, a[href], input, select, textarea, summary, [role="button"], video[controls], audio[controls]';
const OWN_ARROWS = 'input, select, textarea, video[controls], audio[controls]';

/**
 * Make everything but `root` inert (and so out of the accessibility tree
 * and the tab order): every sibling of it and of each of its ancestors. A
 * branch holding a <dialog> is gone into rather than made inert whole, so a
 * dialog opened from here (Get info) still works. Returns the undo.
 */
function inertAround(root) {
  const made = [];
  const hide = (el) => {
    if (el.inert || /^(SCRIPT|STYLE|LINK|TEMPLATE|DIALOG)$/.test(el.tagName)) return;
    if (el.querySelector('dialog')) { for (const c of el.children) hide(c); return; }
    el.inert = true;
    made.push(el);
  };
  for (let el = root; el && el.parentElement && el !== document.body; el = el.parentElement) {
    for (const sib of el.parentElement.children) if (sib !== el) hide(sib);
  }
  return () => { for (const el of made) el.inert = false; };
}

/**
 * Quick Look: the item under the selection, large, over the files view —
 * built only from the row the page already holds, so it never waits for the
 * server. An image shows the tile's own picture at once and sharpens to the
 * large preview (ProgressiveImage); a video plays with its poster up first;
 * a folder or a document shows what it is and how to open it.
 *
 *   ← → (↑ ↓)   step        Space, Esc   close
 *   Return, ⌘↓  open        ⌘I           Get info
 *
 * On a touch screen a sideways swipe steps and a swipe down closes. The keys
 * are taken on window in the capture phase while it is open, so nothing
 * behind it (the grid, the page's shortcuts) sees them.
 */
/**
 * Quick Look with its state, as the files view mounts it — loaded after the
 * page, at its first key or pointer press, so it is no part of showing a
 * folder (nor is the open prefetch, which rides along with it). `apiRef.current` gets { open, dismiss }; `pending` is a key Space
 * asked for before this had loaded, opened as soon as it mounts. Opening an
 * item from here (Return, the Open button) leaves Quick Look first.
 */
export default function QuickLookHost({ apiRef, pending, find, onOpen, onInfo, onOriginalBlob, prefetch, ...state }) {
  // An original the fill-in wants is loaded ahead the way it needs it
  // (lib/original-preload.js), so a neighbour stepped onto gets its preview
  // made just as one waited for does.
  const wantsOriginal = onOriginalBlob ? (f) => previewWanted(f, { probe: probedNow() }) : null;
  const ql = useQuickLook({ ...state, find, wantsOriginal });
  // Whether this browser draws HEIC and TIFF originals, asked once, early.
  useEffect(() => { decodeProbe().catch(() => {}); }, []);
  // Getting a file's page and preview ready while it rests selected
  // (app/files/useOpenPrefetch.js) — loaded with this, after the page.
  useOpenPrefetch(prefetch);
  const live = useRef(ql);
  live.current = ql;
  useEffect(() => {
    if (!apiRef) return undefined;
    apiRef.current = {
      open: (key) => live.current.open(key),
      dismiss: () => live.current.dismiss(),
    };
    if (pending?.current != null) {
      const key = pending.current;
      pending.current = null;
      live.current.open(key);
    }
    return () => { apiRef.current = null; };
  }, [apiRef, pending]);
  const open = (key) => { ql.dismiss(); onOpen?.(key); };
  return <QuickLook ql={ql} find={find} onOpen={open} onInfo={onInfo} onOriginalBlob={onOriginalBlob} />;
}

function QuickLook({ ql, find, onOpen, onInfo, onOriginalBlob }) {
  const root = useRef(null);
  const titleId = useId();
  const key = ql.currentKey;
  const p = key ? parseKey(key) : null;
  const item = key ? find(key) : null;
  const file = p?.type === 'file' ? item : null;
  const folder = p?.type === 'folder' ? item : null;
  const live = useRef(null);
  live.current = { ql, key, file, folder, onOpen, onInfo };
  const hadOriginal = useRef({ id: null, yes: false });

  // Focus into the dialog on open; the page puts it back on close (onClose).
  // While it is open the page behind is inert: out of reach of Tab and of a
  // screen reader, which otherwise reads the grid under the overlay.
  useEffect(() => {
    if (!ql.isOpen || !root.current) return undefined;
    root.current.focus({ preventScroll: true });
    const undo = inertAround(root.current);
    ql.releaseRef.current = undo;
    return () => { if (ql.releaseRef.current === undo) ql.releaseRef.current = null; undo(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ql.isOpen]);

  useEffect(() => {
    if (!ql.isOpen) return undefined;
    const onKey = (e) => {
      const L = live.current;
      const mod = e.metaKey || e.ctrlKey;
      // A dialog opened from here (Get info) has the keys to itself.
      if (e.target?.closest?.('dialog')) return;
      // So does a control of Quick Look's own that has the focus: Return on
      // Close closes, Space on Open opens, a focused player seeks.
      const control = e.target?.closest?.(CONTROL);
      if (control && root.current?.contains(control) && !mod) {
        if (e.key === 'Enter' || e.key === ' ') return;
        if (e.key.startsWith('Arrow') && control.matches(OWN_ARROWS)) return;
      }
      let handled = true;
      if (e.key === 'Escape' || (e.key === ' ' && !e.shiftKey)) {
        if (!e.repeat) L.ql.close();
      } else if (e.key === 'ArrowRight' || (e.key === 'ArrowDown' && !mod)) L.ql.step(1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') L.ql.step(-1);
      else if (e.key === 'Enter' || (mod && e.key === 'ArrowDown')) L.onOpen?.(L.key);
      else if (mod && (e.key === 'i' || e.key === 'I')) L.onInfo?.(L.key);
      else if (e.key === 'Tab') {
        // Kept inside: the header's buttons and the player.
        const list = [...(root.current?.querySelectorAll(FOCUSABLE) || [])];
        if (!list.length) return;
        const i = list.indexOf(document.activeElement);
        const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i + 1) % list.length;
        list[next].focus();
      } else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ql.isOpen]);

  // Swipes.
  const touch = useRef(null);
  const onTouchStart = (e) => {
    const t = e.touches[0];
    touch.current = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, at: performance.now() } : null;
  };
  const onTouchEnd = (e) => {
    const s = touch.current;
    touch.current = null;
    const t = e.changedTouches[0];
    if (!s || !t) return;
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) ql.step(dx < 0 ? 1 : -1);
    else if (dy > 80 && dy > Math.abs(dx) * 1.5) ql.close();
  };

  if (!ql.isOpen || !key) return null;

  const kind = file ? effectiveKind(file) : folder ? 'folder' : null;
  const md = file?.metadata || {};
  const position = positionLabel(ql.index, ql.count, ql.more);
  const facts = [
    position,
    md.width && md.height ? `${md.width} × ${md.height}` : null,
    kind === 'video' && md.duration ? fmtDuration(md.duration) : null,
    file?.size ? fmtSize(file.size) : null,
    folder && folder.count != null ? `${folder.count} file${folder.count === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');
  const name = file?.name || folder?.name || '';
  // A preview made while the original is on screen (the fill-in, from this
  // very download) must not send the picture back through the thumbnail:
  // the original stays one of the layers for as long as this file is shown.
  if (hadOriginal.current.id !== file?.id) hadOriginal.current = { id: file?.id, yes: false };
  if (file && !file.posterUrl) hadOriginal.current.yes = true;
  // An image with no layer this browser can show (a HEIC or TIFF outside
  // Safari with no thumbnail, a RAW) gets the kind panel, as a document does.
  const layers = kind === 'image' ? imageLayers(file, { keepOriginal: hadOriginal.current.yes }) : null;

  return (
    <div
      ref={root}
      className="ql"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-quicklook=""
      data-file-id={file?.id}
      tabIndex={-1}
    >
      <div className="ql-backdrop" onClick={() => ql.close()} aria-hidden />
      <div className="ql-panel">
        <header className="ql-head">
          <div className="ql-title">
            <h2 id={titleId} className="truncate" title={name}>{name}</h2>
            <span className="small muted truncate">{facts}</span>
          </div>
          <div className="spacer" />
          <button type="button" className="btn btn-sm" onClick={() => onOpen?.(key)} title="Open (Return)">Open</button>
          {file && <a className="btn btn-sm" href={`/api/files/${file.id}/download`}>Download</a>}
          <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={() => ql.close()} aria-label="Close" title="Close (Space)">
            <Icon name="x" />
          </button>
        </header>
        <div className="ql-stage" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} style={{ '--ratio': md.width && md.height ? md.width / md.height : 4 / 3 }}>
          {kind === 'image' && layers.length > 0 && <ImageItem file={file} layers={layers} onSharp={() => ql.onSharp(key)} onOriginalBlob={onOriginalBlob} />}
          {kind === 'video' && <VideoItem file={file} />}
          {kind === 'audio' && <AudioItem file={file} />}
          {kind === 'folder' && (
            <div className="ql-card">
              <Icon name="folder" size={56} strokeWidth={1.25} className="ql-card-icon" />
              <p className="ql-card-name">{folder.name}</p>
              <p className="small muted">Folder{folder.count != null ? ` · ${folder.count} file${folder.count === 1 ? '' : 's'}` : ''}</p>
              <button type="button" className="btn btn-primary" onClick={() => onOpen?.(key)}>Open</button>
            </div>
          )}
          {file && ((kind === 'image' && !layers.length) || (kind !== 'image' && kind !== 'video' && kind !== 'audio')) && (
            <div className="ql-card">
              <p className="ql-card-kind mono">{String(file.mime || kind || 'file').toUpperCase()}</p>
              <p className="ql-card-name">{file.name}</p>
              <p className="small muted">{fmtSize(file.size)}</p>
              <div className="row" style={{ gap: 'var(--s2)', justifyContent: 'center' }}>
                <button type="button" className="btn btn-primary" onClick={() => onOpen?.(key)}>Open</button>
                <a className="btn" href={`/api/files/${file.id}/download`}>Download</a>
              </div>
            </div>
          )}
        </div>
        <p className="sr-only" aria-live="polite">{name}, {position}</p>
        <p className="ql-keys small muted" aria-hidden>← → step · Space closes · Return opens · {modKey()}I info</p>
      </div>
    </div>
  );
}

/**
 * An image: the tile's picture, then the large preview. A file with no
 * preview shows its original instead — fetched as a blob, with a progress bar
 * once it takes a while — and a writer's browser makes the preview from that
 * same download (`onOriginalBlob`, the page's backfill).
 */
function imageLayers(file, { keepOriginal = false } = {}) {
  const first = tilePicture(file.id) || thumbSources(file, 'info').src || file.thumbnailUrl;
  const drawable = drawableKind(file, { probe: probedNow() });
  return [
    { src: first, quality: 'thumb' },
    { src: file.posterUrl, quality: 'preview' },
    // A file with no preview: its original, when this browser can draw it.
    (!file.posterUrl || keepOriginal) && drawable ? { src: file.url, quality: 'original' } : null,
  ].filter((l) => l && l.src);
}

function ImageItem({ file, layers, onSharp, onOriginalBlob }) {
  const md = file.metadata || {};
  // Handed to the fill-in only when it would make a preview from it: never
  // for a file that by design gets none (lib/preview-wanted.js).
  const blob = !file.posterUrl && onOriginalBlob && previewWanted(file, { probe: probedNow() });
  return (
    <ProgressiveImage
      key={file.id}
      id={file.id}
      layers={layers}
      alt={file.name}
      width={Number(md.width) || 0}
      height={Number(md.height) || 0}
      onBlob={blob ? (b) => onOriginalBlob(file, b) : undefined}
      preloaded={preloaded}
      onDecoded={(q) => {
        // What is on screen first may already be sharp (a neighbour loaded
        // ahead): then it is both.
        mark('thumb', file.id);
        if (q !== 'thumb') { mark('sharp', file.id); onSharp?.(); }
      }}
    />
  );
}

/**
 * A plain <video>, not the file page's player: its keys are Quick Look's.
 * It plays at once (Space or Return was the gesture); refused, it tries
 * muted. Stepping away or closing drops its source, so the download stops.
 */
function VideoItem({ file }) {
  const ref = useRef(null);
  const poster = file.posterUrl || file.thumbnailUrl || undefined;
  const under = tilePicture(file.id) || thumbSources(file, 'info').src;
  const underRef = useRef(null);
  // The tile's picture is usually decoded already: on screen with the first frame.
  useEffect(() => {
    if (underRef.current?.complete && underRef.current.naturalWidth) mark('thumb', file.id);
  }, [file.id]);
  useEffect(() => {
    const v = ref.current;
    if (!v) return undefined;
    v.play()?.catch?.(() => { v.muted = true; v.play()?.catch?.(() => {}); });
    return () => {
      queueMicrotask(() => {
        if (v.isConnected) return;
        try { v.pause(); v.removeAttribute('src'); v.load(); } catch {}
      });
    };
  }, [file.id]);
  return (
    <>
      {/* The tile's picture under the player until its poster or a frame is up. */}
      {under && (
        <img
          ref={underRef}
          className="ql-under"
          src={under}
          alt=""
          aria-hidden
          onLoad={() => mark('thumb', file.id)}
        />
      )}
      <video
        key={file.id}
        ref={ref}
        className="ql-video"
        src={file.url}
        poster={poster}
        controls
        playsInline
        preload="metadata"
        onLoadedData={(e) => { mark('sharp', file.id); e.currentTarget.classList.add('has-frame'); }}
        onPlaying={() => mark('play', file.id)}
      />
    </>
  );
}

function AudioItem({ file }) {
  return (
    <div className="ql-card">
      <p className="ql-card-name">{file.name}</p>
      <audio src={file.url} controls autoPlay style={{ width: 'min(480px, 100%)' }} />
    </div>
  );
}
