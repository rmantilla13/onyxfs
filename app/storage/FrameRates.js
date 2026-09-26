'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/app/components/ui/Toast';

const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;

/**
 * The Frame rates card on Admin → Usage, and its "Probe all videos".
 *
 * A video's exact rate, frame count and start timecode are read from its
 * container at upload; videos from before that have none until someone who
 * may edit one opens it. Until then its timecodes, and every comment pinned
 * to it, count an assumed 30fps. Probing runs the probe route (a few range
 * reads of each file's header, a few seconds a call) until it has seen every
 * video once, then reloads the page for the new counts.
 *
 * `summary` is frameModelSummary's: { videos, missing, unreadable }.
 */
export default function FrameRates({ summary }) {
  const router = useRouter();
  const toast = useToast();
  const [run, setRun] = useState(null);

  const probe = async () => {
    let after = '';
    const t = { checked: 0, found: 0, unreadable: 0, skipped: 0, failed: 0 };
    setRun({ running: true, ...t });
    try {
      for (;;) {
        const r = await fetch('/api/admin/storage/probe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ after }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `Probing stopped (HTTP ${r.status}).`);
        for (const k of Object.keys(t)) t[k] += body[k] || 0;
        after = body.after || after;
        setRun({ running: true, ...t });
        if (body.done) break;
      }
      setRun({ running: false, ...t });
      toast.success(`Probed ${plural(t.checked, 'video')}.`);
      router.refresh();
    } catch (e) {
      setRun({ running: false, ...t, error: e.message });
    }
  };

  const { videos = 0, missing = 0, unreadable = 0 } = summary || {};
  return (
    <section className="card storage-card" aria-labelledby="st-rates">
      <h2 id="st-rates" className="storage-h2">Frame rates</h2>
      {missing > 0 ? (
        <p className="storage-stat">
          <strong>{missing.toLocaleString()}</strong>
          <span className="muted small"> of {plural(videos, 'video')} without an exact frame rate</span>
        </p>
      ) : (
        <p className="storage-stat"><strong>{videos ? 'All known' : 'No videos yet'}</strong></p>
      )}
      <p className="small muted" style={{ margin: '0 0 var(--s3)' }}>
        {missing > 0
          ? 'Until one is read, timecodes and comments on these count an assumed 30 fps. Probing reads each file’s header — a few kilobytes — and changes nothing else.'
          : 'Each video’s rate, length in frames and start timecode are read from the file as it is uploaded.'}
        {unreadable > 0 && ` ${plural(unreadable, 'video')} could not be read (WebM, say) and ${unreadable === 1 ? 'uses' : 'use'} the assumed rate.`}
      </p>
      {run && !run.running && !run.error && (
        <p className="small" role="status" style={{ margin: '0 0 var(--s3)' }}>
          {`Read ${plural(run.found, 'rate')}`}
          {run.unreadable > 0 && `; ${run.unreadable.toLocaleString()} had none to read`}
          {run.skipped > 0 && `; ${run.skipped.toLocaleString()} not in storage the server can read`}
          {run.failed > 0 && `; ${run.failed.toLocaleString()} could not be reached — probe again to retry`}
          .
        </p>
      )}
      {run?.error && <p className="small" role="alert" style={{ margin: '0 0 var(--s3)', color: 'var(--danger)' }}>{run.error}</p>}
      {missing > 0 && (
        <button type="button" className="btn btn-sm" onClick={probe} disabled={run?.running}>
          {run?.running ? `Probing… ${run.checked.toLocaleString()}` : run?.error ? 'Try again' : 'Probe all videos'}
        </button>
      )}
    </section>
  );
}
