'use client';

import { useEffect, useRef, useState } from 'react';
import { fmtSize } from './FileCard';

/**
 * The upload tray: every file in the queue with its own progress, the batch
 * as a whole, and cancel / retry per file.
 *
 * Progress bars scale a fill with `transform`, eased between updates, so a
 * bar glides instead of jumping in 5% steps and never triggers layout. The
 * queue reports at most once a frame (lib/upload-client.js), which is what
 * keeps a thousand-file drop from re-rendering this per progress event.
 */

// A long drop renders its first rows and a count, not a thousand-row list.
const MAX_ROWS = 300;

function fmtEta(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'less than a minute left';
  const m = Math.round(seconds / 60);
  return m < 60 ? `about ${m} min left` : `about ${Math.floor(m / 60)} h ${m % 60} min left`;
}

function Bar({ value, status }) {
  return (
    <div className={`upbar upbar-${status}`} aria-hidden>
      <div className="upbar-fill" style={{ transform: `scaleX(${Math.max(0, Math.min(1, value))})` }} />
    </div>
  );
}

// What sits beside the name: the size, and how far along a running file is.
function meta(item) {
  if (item.status === 'canceled') return 'Canceled';
  if (item.status === 'uploading' && item.total) return `${Math.round((item.sent / item.total) * 100)}% · ${fmtSize(item.total)}`;
  return fmtSize(item.total);
}

export default function UploadPanel({ snapshot, onCancel, onRetry, onRetryFailed, onClear }) {
  const [collapsed, setCollapsed] = useState(false);
  const listRef = useRef(null);
  const touched = useRef(0);

  // Keep the file that is uploading now in view as the queue works down a
  // long list, unless someone has just scrolled it themselves.
  useEffect(() => {
    const list = listRef.current;
    if (!list || Date.now() - touched.current < 4000) return;
    const row = list.querySelector('.upload-row.is-uploading');
    if (!row) return;
    const top = row.offsetTop - list.offsetTop;
    if (top < list.scrollTop || top + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTo({ top: Math.max(0, top - row.offsetHeight), behavior: 'smooth' });
    }
  }, [snapshot]);

  if (!snapshot || !snapshot.items.length) return null;
  const { items, total, sent, speed, eta, running, counts } = snapshot;
  const pct = total ? Math.round((sent / total) * 100) : 0;
  const title = running
    ? `Uploading ${counts.done + 1 > counts.all ? counts.all : counts.done + 1} of ${counts.all}`
    : counts.error
      ? `${counts.error} failed · ${counts.done} uploaded`
      : `${counts.done} uploaded`;
  const detail = running
    ? [`${pct}%`, speed ? `${fmtSize(speed)}/s` : '', fmtEta(eta)].filter(Boolean).join(' · ')
    : `${fmtSize(total)}`;
  const status = running ? 'uploading' : counts.error ? 'error' : 'done';

  return (
    <section className="upload-panel" aria-label="Uploads">
      <div className="upload-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="small" style={{ fontWeight: 600 }} aria-live="polite">{title}</div>
          <div className="small muted">{detail}</div>
        </div>
        <button
          className="btn btn-sm"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Show uploads' : 'Hide uploads'}
        >
          {collapsed ? '▴' : '▾'}
        </button>
        {!running && (
          <button className="btn btn-sm" onClick={onClear} aria-label="Close uploads">✕</button>
        )}
      </div>
      <Bar value={total ? sent / total : 0} status={status} />
      {!collapsed && (
        <>
          <ul
            className="upload-list"
            ref={listRef}
            onWheel={() => { touched.current = Date.now(); }}
            onTouchMove={() => { touched.current = Date.now(); }}
            onPointerDown={() => { touched.current = Date.now(); }}
          >
            {items.slice(0, MAX_ROWS).map((item) => (
              <li key={item.id} className={`upload-row is-${item.status}`}>
                <div className="row small" style={{ gap: 'var(--s2)' }}>
                  <span className="upload-check" aria-hidden>{item.status === 'done' ? '✓' : ''}</span>
                  <span className="truncate" style={{ flex: 1, minWidth: 0 }} title={item.folder ? `${item.folder}/${item.name}` : item.name}>
                    {item.name}
                    {item.folder && <span className="muted"> · {item.folder}</span>}
                  </span>
                  <span className="muted" style={{ flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' }}>{meta(item)}</span>
                  {(item.status === 'queued' || item.status === 'uploading') && (
                    <button className="upload-action" onClick={() => onCancel(item.id)} aria-label={`Cancel ${item.name}`}>✕</button>
                  )}
                  {(item.status === 'error' || item.status === 'canceled') && (
                    <button className="upload-action" onClick={() => onRetry(item.id)} aria-label={`Retry ${item.name}`}>Retry</button>
                  )}
                </div>
                {item.status === 'uploading' && (
                  <Bar value={item.total ? item.sent / item.total : 0} status={item.status} />
                )}
                {item.status === 'error' && <div className="small upload-error">{item.error}</div>}
              </li>
            ))}
          </ul>
          {items.length > MAX_ROWS && (
            <div className="small muted" style={{ padding: 'var(--s2) var(--s4)' }}>and {items.length - MAX_ROWS} more</div>
          )}
          {!running && counts.error > 0 && (
            <div className="row" style={{ padding: 'var(--s2) var(--s4) var(--s3)' }}>
              <div className="spacer" />
              <button className="btn btn-sm" onClick={onRetryFailed}>Retry failed</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
