'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import FileCard from '@/app/components/ui/FileCard';
import Icon from '@/app/components/ui/Icon';
import { deriveAuto } from '@/lib/dam';

// Cards on screen before anything else is: loaded at once, first.
const EAGER_CARDS = 8;

const labelFor = (f) => deriveAuto(f).format || f.kind;

/**
 * The files of one folder of a folder link, as the library's cards — each a
 * link to the file's own page under the link, with its download beside it —
 * and the next page when the end of the grid comes near (or on the button,
 * which is there for a keyboard and for when the observer is not).
 *
 * A guest's grid: no selection, no menus, nothing that edits, and no
 * thumbnail backfill (FileCard's onMissingThumb is for someone who may edit
 * the file). Every page comes from /s/<token>/list, which decides again
 * whether the link still lets this browser in.
 */
export default function FolderFiles({ token, sub = '', initial = [], cursor: firstCursor = null }) {
  const [files, setFiles] = useState(initial);
  const [cursor, setCursor] = useState(firstCursor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const sentinel = useRef(null);
  const inflight = useRef(false);

  const base = `/s/${encodeURIComponent(token)}`;
  const fileHref = (f) => `${base}/files/${encodeURIComponent(f.id)}`;

  const more = useCallback(async () => {
    if (!cursor || inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ cursor });
      if (sub) qs.set('path', sub);
      const r = await fetch(`${base}/list?${qs}`, { cache: 'no-store' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(body.error || `Could not load more (HTTP ${r.status}).`);
        return;
      }
      setFiles((prev) => {
        const seen = new Set(prev.map((f) => f.id));
        return [...prev, ...(body.files || []).filter((f) => !seen.has(f.id))];
      });
      setCursor(body.cursor || null);
    } catch (e) {
      setError(e.message || 'Could not load more.');
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }, [base, cursor, sub]);

  // The next page as the end of the grid comes into view — once, not again
  // after a failure: then the button is the way to try again.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !cursor || error || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) more();
    }, { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, error, more]);

  return (
    <>
      <div className="files-grid">
        {files.map((f, i) => (
          <div key={f.id} className="share-tile">
            <FileCard file={f} href={fileHref(f)} label={labelFor(f)} eager={i < EAGER_CARDS} />
            <a
              className="btn btn-icon share-tile-download"
              href={`${fileHref(f)}/download`}
              aria-label={`Download ${f.name}`}
              title="Download"
            >
              <Icon name="download" size={16} />
            </a>
          </div>
        ))}
      </div>
      {cursor && (
        <div className="share-more" ref={sentinel}>
          <button type="button" className="btn" onClick={more} disabled={busy}>
            {busy ? 'Loading…' : 'Show more'}
          </button>
        </div>
      )}
      {error && <p className="small share-more-error" role="alert">{error}</p>}
    </>
  );
}
