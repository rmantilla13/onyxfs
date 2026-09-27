'use client';

import { useEffect, useState } from 'react';
import Popover from '@/app/components/ui/Popover';
import Icon from '@/app/components/ui/Icon';
import { thumbSources } from '@/lib/renditions';
import { listingParams } from '@/lib/views';
import { kindLabel } from '@/lib/file-info';

/**
 * Activity: the twenty files most recently added or changed in this drive —
 * beneath the open folder, when one is open — newest first. Nothing new
 * behind it: it is the listing the page reads (GET /api/files), flattened
 * and ordered by modification, so it shows only what the viewer may see,
 * asked for each time it is opened.
 */
const COUNT = 20;

/** "just now", "5 min ago", "3 h ago", "yesterday", "12 Sep". */
function ago(ms, now = Date.now()) {
  const s = Math.max(0, (now - Number(ms)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'yesterday';
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return new Date(Number(ms)).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function ActivityList({ filespaceId, folder, rootName, onOpen, onShowAll, close }) {
  const [state, setState] = useState({ files: null, error: null });
  useEffect(() => {
    let live = true;
    const p = listingParams({ folder, flat: true, sort: 'modified' }, { filespaceId, limit: COUNT });
    fetch(`/api/files?${p}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => { if (live) setState({ files: (d.files || []).slice(0, COUNT), error: null }); })
      .catch((e) => { if (live) setState({ files: [], error: e.message }); });
    return () => { live = false; };
  }, [filespaceId, folder]);

  const where = folder ? folder.split('/').pop() : rootName;
  return (
    <>
      <div className="activity-head">
        <strong className="small">Recent activity</strong>
        <span className="small muted truncate">in {where}</span>
      </div>
      {state.files === null ? (
        <ul className="activity-list" aria-busy="true">
          {Array.from({ length: 5 }, (_, i) => <li key={i} className="activity-row is-skeleton"><span className="activity-thumb" /><span className="skeleton-line" /></li>)}
        </ul>
      ) : state.error ? (
        <p className="small activity-empty" role="alert" style={{ color: 'var(--danger)' }}>Could not load activity. {state.error}</p>
      ) : !state.files.length ? (
        <p className="small muted activity-empty">Nothing here yet.</p>
      ) : (
        <ul className="activity-list">
          {state.files.map((f) => {
            const changed = Number(f.updatedAt) - Number(f.createdAt) > 60_000;
            const src = thumbSources(f, 'palette').src;
            return (
              <li key={f.id}>
                <button type="button" className="activity-row" onClick={() => { close(); onOpen(f); }} title={f.folder ? `${f.folder}/${f.name}` : f.name}>
                  <span className="activity-thumb" aria-hidden>
                    {/* A presigned URL, which next/image cannot fetch through its optimizer. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {src ? <img src={src} alt="" loading="lazy" decoding="async" /> : <Icon name="file" size={14} />}
                  </span>
                  <span className="activity-text">
                    <span className="activity-name truncate">{f.name}</span>
                    <span className="activity-meta truncate">
                      {changed ? 'Changed' : 'Added'} {ago(changed ? f.updatedAt : f.createdAt)}
                      {' · '}{f.folder || rootName}
                    </span>
                  </span>
                  <span className="activity-kind small muted">{kindLabel(f)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {onShowAll && (
        <div className="activity-foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { close(); onShowAll(); }}>
            <Icon name="clock" size={14} />Show everything in Recent
          </button>
        </div>
      )}
    </>
  );
}

export default function ActivityPopover(props) {
  return (
    <Popover
      label="Recent activity"
      buttonClassName="btn btn-ghost btn-icon hdr-btn"
      className="activity-pop"
      trigger={<Icon name="clock" size={18} />}
    >
      {({ close }) => <ActivityList {...props} close={close} />}
    </Popover>
  );
}
