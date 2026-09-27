'use client';

import { Fragment, useSyncExternalStore } from 'react';
import { fmtSize, fmtDuration, effectiveKind } from '@/lib/media';
import { deriveAuto } from '@/lib/dam';

/**
 * A file's metadata fields as a card's line, a tile's caption or a list's
 * cells show them — the view's `fields` (lib/views.js), which are the list's
 * column keys (lib/list-columns.js).
 *
 * Dates are the one awkward kind. The files page is rendered on the server,
 * whose clock and locale are not the viewer's, so a date is written in UTC
 * there and while the page hydrates, and in the viewer's own zone from the
 * render after (useHydrated) — never a hydration mismatch, and never a time
 * that is somebody else's.
 */

const dateFmt = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }) : null;
const timeFmt = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }) : null;
const utcDateFmt = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }) : null;
const utcTimeFmt = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat('en-US', { timeStyle: 'short', timeZone: 'UTC' }) : null;
const noSubscribe = () => () => {};
export const useHydrated = () => useSyncExternalStore(noSubscribe, () => true, () => false);

/** A moment as a date and (unless `dateOnly`) a time, in the viewer's zone once hydrated. */
export function When({ at, dateOnly = false }) {
  const local = useHydrated();
  if (!at || !dateFmt) return <span className="muted">—</span>;
  const d = new Date(Number(at));
  if (Number.isNaN(d.getTime())) return <span className="muted">—</span>;
  const [df, tf] = local ? [dateFmt, timeFmt] : [utcDateFmt, utcTimeFmt];
  return (
    <time dateTime={d.toISOString()} title={local ? d.toLocaleString() : undefined}>
      {df.format(d)}{!dateOnly && <span className="filelist-time"> {tf.format(d)}</span>}
    </time>
  );
}

/** 'YYYY-MM-DD' as a local calendar day — not midnight UTC, which is the day before west of Greenwich. */
export function localDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function Day({ value }) {
  const local = useHydrated();
  const day = localDay(value);
  if (!day || !dateFmt || !local) return <>{String(value)}</>;
  return <>{dateFmt.format(day)}</>;
}

const KIND_WORDS = { image: 'Image', video: 'Video', audio: 'Audio', doc: 'Document', other: 'File' };

/**
 * One field of one file: a string, a date to be written by <When>, or '' for
 * nothing to show. `field` is the column definition (lib/list-columns.js).
 */
export function fieldValue(file, field, { rootName = 'All files' } = {}) {
  const md = file?.metadata || {};
  switch (field.key) {
    case 'size': return fmtSize(file.size);
    case 'type': return deriveAuto(file).format || KIND_WORDS[effectiveKind(file)] || '';
    case 'modified': return file.updatedAt ? { at: file.updatedAt } : '';
    case 'added': return file.createdAt ? { at: file.createdAt } : '';
    case 'duration': return fmtDuration(md.duration);
    case 'dimensions': return md.width && md.height ? `${md.width} × ${md.height}` : '';
    case 'aspect_ratio': return deriveAuto(file).aspect_ratio || '';
    case 'added_by': return file.createdBy || '';
    case 'folder': return file.folder || rootName;
    case 'tags': return (file.tags || []).join(', ');
    default: {
      const key = field.field?.key;
      const v = key ? md[key] : undefined;
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '';
      if (field.field?.type === 'date') return { day: String(v) };
      return Array.isArray(v) ? v.join(', ') : String(v);
    }
  }
}

/**
 * The fields that have a value for this file, as one line: "0:15 · 1920 ×
 * 1080 · 834 KB". A field with nothing to say is left out rather than shown
 * as a dash, so a line of three fields for a document reads "PDF · 2 MB".
 */
export function FieldLine({ file, fields, rootName, className = 'field-line' }) {
  const parts = [];
  for (const f of fields || []) {
    const v = fieldValue(file, f, { rootName });
    if (!v) continue;
    parts.push({ key: f.key, label: f.label, v });
  }
  return (
    <span className={className}>
      {parts.map((p, i) => (
        <Fragment key={p.key}>
          {i > 0 && <span className="field-sep" aria-hidden> · </span>}
          <span className="field-part" title={p.label}>
            {typeof p.v === 'string' ? p.v : p.v.at ? <When at={p.v.at} dateOnly /> : <Day value={p.v.day} />}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
