'use client';

import { Fragment, useSyncExternalStore } from 'react';
// lib/media.js alone, not lib/dam.js: every card draws these, and the
// storage pages' pictures come from the same module (FileCard).
import { fmtSize, fmtDuration, effectiveKind, fileFormat, aspectLabel } from '@/lib/media';
import { whenCreated, whenModified } from '@/lib/file-dates';

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
const dayFmt = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }) : null;
const timeFmt = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }) : null;
const utcDateFmt = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }) : null;
const utcTimeFmt = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat('en-US', { timeStyle: 'short', timeZone: 'UTC' }) : null;
const noSubscribe = () => () => {};
export const useHydrated = () => useSyncExternalStore(noSubscribe, () => true, () => false);

const DAY_MS = 24 * 60 * 60 * 1000;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * How a recent moment is said: "Today" and "Yesterday" (with the time), up
 * to six days as "3 days ago", else nothing — the date is written. Local
 * calendar days, as a person counts them; a moment ahead of the clock (a
 * file from a machine whose clock runs fast) is written as a date too.
 */
export function relativeDay(d, now = new Date()) {
  if (d.getTime() > now.getTime() + 60 * 1000) return null;
  const days = Math.round((startOfDay(now) - startOfDay(d)) / DAY_MS);
  if (days === 0) return { words: 'Today', withTime: true };
  if (days === 1) return { words: 'Yesterday', withTime: true };
  if (days < 7) return { words: `${days} days ago`, withTime: false };
  return null;
}

/**
 * A moment as a date and (unless `dateOnly`) a time, in the viewer's zone
 * once hydrated. `relative` says a recent one as "Today, 2:25 PM" or "3 days
 * ago", and an older one by its day with the year only when it is not this
 * one — the listing's dates, where a full date was the part that truncated.
 * The absolute moment is always the title, and Get info keeps the full form.
 * Decided at render, never on a timer: the words are right when they are
 * drawn, and a listing redraws as it is used.
 */
export function When({ at, dateOnly = false, relative = false }) {
  const local = useHydrated();
  if (!at || !dateFmt) return <span className="muted">—</span>;
  const d = new Date(Number(at));
  if (Number.isNaN(d.getTime())) return <span className="muted">—</span>;
  const [df, tf] = local ? [dateFmt, timeFmt] : [utcDateFmt, utcTimeFmt];
  // Relative only once hydrated: "Today" is the viewer's today, which the
  // server does not know.
  if (local && relative) {
    const now = new Date();
    const recent = relativeDay(d, now);
    const title = d.toLocaleString();
    if (recent) {
      return (
        <time dateTime={d.toISOString()} title={title}>
          {recent.words}{recent.withTime && !dateOnly && <span className="filelist-time">, {tf.format(d)}</span>}
        </time>
      );
    }
    const day = d.getFullYear() === now.getFullYear() && dayFmt ? dayFmt.format(d) : df.format(d);
    return (
      <time dateTime={d.toISOString()} title={title}>
        {day}{!dateOnly && <span className="filelist-time"> {tf.format(d)}</span>}
      </time>
    );
  }
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
    case 'type': return fileFormat(file.name, file.mime) || KIND_WORDS[effectiveKind(file)] || '';
    case 'modified': { const at = whenModified(file); return at ? { at } : ''; }
    case 'added': { const at = whenCreated(file); return at ? { at } : ''; }
    case 'duration': return fmtDuration(md.duration);
    case 'dimensions': return md.width && md.height ? `${md.width} × ${md.height}` : '';
    case 'aspect_ratio': return aspectLabel(md.width, md.height) || '';
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
            {typeof p.v === 'string' ? p.v : p.v.at ? <When at={p.v.at} dateOnly relative /> : <Day value={p.v.day} />}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
