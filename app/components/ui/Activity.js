'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { activitySnapshot, subscribeActivity, SHOW_AFTER_MS } from '@/lib/activity';

/**
 * Where work in progress shows, bottom left: this panel for what the page is
 * doing (lib/activity.js — a folder moving, files being removed, a thumbnail
 * being redrawn…), and under it the upload tray, which puts itself here
 * (UploadPanel, through a portal into #onyx-dock). One place to look, and the
 * two never cover each other.
 *
 * Mounted once, in the root layout, so a task started on any page shows —
 * and keeps showing across a navigation, since the work does not stop there.
 */
export function ActivityDock() {
  return (
    <div className="dock" id="onyx-dock">
      <ActivityPanel />
    </div>
  );
}

const EMPTY = [];

function ActivityPanel() {
  const tasks = useSyncExternalStore(subscribeActivity, activitySnapshot, () => EMPTY);

  // A task shows once it has run SHOW_AFTER_MS: re-render when the next one
  // comes due.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const due = tasks.map((t) => t.startedAt + SHOW_AFTER_MS).filter((at) => at > now);
    if (!due.length) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(...due) - Date.now()) + 10);
    return () => clearTimeout(timer);
  }, [tasks, now]);

  const shown = tasks.filter((t) => t.startedAt + SHOW_AFTER_MS <= now);
  if (!shown.length) return null;
  return (
    <section className="work-panel" aria-label="In progress">
      <ul className="work-list">
        {shown.map((t) => <ActivityRow key={t.id} task={t} />)}
      </ul>
    </section>
  );
}

function ActivityRow({ task }) {
  const { title, detail, done, total } = task;
  const known = Number(total) > 0 && done != null;
  const fraction = known ? Math.max(0, Math.min(1, Number(done) / Number(total))) : 0;
  return (
    <li className="work-row">
      <div className="small work-title truncate" title={title}>{title}</div>
      {detail ? <div className="small muted work-detail truncate" title={detail}>{detail}</div> : null}
      <div
        className={`upbar ${known ? 'upbar-uploading' : 'upbar-indeterminate'}`}
        role="progressbar"
        aria-label={title}
        aria-valuemin={known ? 0 : undefined}
        aria-valuemax={known ? Number(total) : undefined}
        aria-valuenow={known ? Number(done) : undefined}
        aria-valuetext={detail || undefined}
      >
        <div className="upbar-fill" style={known ? { transform: `scaleX(${fraction})` } : undefined} />
      </div>
    </li>
  );
}
