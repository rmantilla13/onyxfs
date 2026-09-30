'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useToast } from '@/app/components/ui/Toast';
import { useConfirm } from '@/app/components/ui/Confirm';
import { fmtSize } from '@/lib/media';
import { cleanFolder } from '@/lib/folder-ops';
import { previewScopeQuery } from '@/lib/preview-jobs';
import { createPreviewRun, carriedOver, unfinished } from '@/lib/preview-runner';
import { decodeProbe } from '@/lib/decode-probe';
import { AdminCard } from '../_ui/AdminPage';
import { Meter } from '../_ui/StatTile';
import { api } from '../_ui/api';

// Where a run is kept while it goes, so a page left in the middle of one can
// pick it up again: this tab only, and gone with it.
const KEPT = 'admin.previews.run';
const PAGE = 50;

const num = (v) => (Number(v) || 0).toLocaleString('en-US');
const files = (v) => `${num(v)} file${Number(v) === 1 ? '' : 's'}`;
const KINDS = { both: 'Pictures and videos', images: 'Pictures', videos: 'Videos' };
const JOBS = { redraw: 'everything', sizes: 'smaller sizes', placeholder: 'placeholder' };
const STATUS = {
  running: 'Regenerating…',
  pausing: 'Pausing once the files under way are done…',
  paused: 'Paused',
  stopping: 'Stopping once the files under way are done…',
  stopped: 'Stopped',
  done: 'Finished',
  error: 'The list of files stopped',
};

function readKept() {
  try {
    const raw = window.sessionStorage.getItem(KEPT);
    return raw ? carriedOver(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
function writeKept(state) {
  try { window.sessionStorage.setItem(KEPT, JSON.stringify(state)); } catch { /* private mode: the run just is not kept */ }
}
function dropKept() {
  try { window.sessionStorage.removeItem(KEPT); } catch { /* nothing kept */ }
}

/** "Pictures in Team › Campaigns, missing only". */
function scopeWords(params = {}, drives = []) {
  const where = params.drive ? (drives.find((d) => d.id === params.drive)?.name || 'a drive') : 'the whole library';
  const folder = params.folder ? ` › ${params.folder.split('/').join(' › ')}` : '';
  return `${KINDS[params.kinds] || KINDS.both} in ${where}${folder}, ${params.mode === 'everything' ? 'everything' : 'missing only'}`;
}

/** The redrawn, the resized and the placeheld, as a phrase. */
function jobWords(jobs = {}) {
  const parts = [];
  if (jobs.redraw) parts.push(`${num(jobs.redraw)} drawn whole`);
  if (jobs.sizes) parts.push(`${num(jobs.sizes)} given smaller sizes`);
  if (jobs.placeholder) parts.push(`${num(jobs.placeholder)} given a placeholder`);
  return parts.join(', ');
}

/** What this browser could not be handed, and who makes it instead. */
function leftOutWords(left, mac) {
  if (!left) return null;
  const parts = [];
  if (left.heic) parts.push(`${files(left.heic)} in HEIC`);
  if (left.tiff) parts.push(`${files(left.tiff)} in TIFF`);
  if (left.never) parts.push(`${files(left.never)} in formats no browser decodes`);
  if (!parts.length) return null;
  const safari = left.heic || left.tiff ? ' Safari decodes HEIC and TIFF;' : '';
  return `Left out: ${parts.join(', ')}.${safari} ${mac} makes these as it syncs a drive.`;
}

/**
 * Admin → Previews' run: choose a scope — the whole library or a drive, a
 * folder in it, pictures or videos or both — and whether to make only what
 * is missing or everything again, then draw them in this browser, a few at
 * a time (lib/preview-runner.js), with the jobs in lib/thumbnail-regen.js.
 * Pause lets the files under way finish and takes no more; Stop does the
 * same and ends the run. Leaving the page pauses it, and it is kept for
 * this tab (sessionStorage), to carry on from where it was.
 */
export default function PreviewsRunner({ drives = [], mac }) {
  const router = useRouter();
  const toast = useToast();
  const { confirm, confirmElement } = useConfirm();
  const id = useId();
  const [form, setForm] = useState({ drive: '', folder: '', kinds: 'both', mode: 'missing' });
  const [run, setRun] = useState(null);
  const control = useRef(null);
  const live = useRef(true);
  const lastStatus = useRef(null);
  const regen = useRef(null);

  // A run left in this tab — the page closed or navigated away mid-run.
  useEffect(() => {
    live.current = true;
    const kept = readKept();
    if (kept) {
      lastStatus.current = kept.status;
      setRun(kept);
    }
    return () => {
      live.current = false;
      // It just stops taking files; the ones under way finish and are kept.
      control.current?.pause();
    };
  }, []);

  const onChange = (state) => {
    writeKept(state);
    if (live.current) setRun(state);
    const was = lastStatus.current;
    lastStatus.current = state.status;
    if (was !== state.status && (state.status === 'done' || state.status === 'stopped')) {
      if (live.current) router.refresh();
      if (state.status === 'done' && live.current) toast.success(`Previews: finished ${files(state.done + state.skipped + state.failed)}.`);
    }
  };

  const work = async (file, job, opts) => {
    regen.current ||= import('@/lib/thumbnail-regen').catch((e) => { regen.current = null; throw e; });
    const { runPreviewJob } = await regen.current;
    return runPreviewJob(file, job, opts);
  };
  const listFor = (params) => (after) => api(`/api/admin/previews/candidates?${previewScopeQuery(params, { after, limit: PAGE })}`);
  // A run is heard only while it is this page's run: one put away for
  // another ("Start another") says nothing more, even a last count of bytes.
  const own = (make) => {
    let self = null;
    self = make((state) => { if (control.current === self) onChange(state); });
    control.current = self;
    return self;
  };

  const start = async (e) => {
    e?.preventDefault();
    if (form.mode === 'everything') {
      const ok = await confirm({
        title: 'Regenerate every preview?',
        body: 'Every thumbnail in the scope is drawn again from its original, replacing the one there — a cover someone chose for a video included. Pictures are downloaded whole.',
        confirmLabel: 'Regenerate everything',
      });
      if (!ok) return;
    }
    // What this browser decodes beyond the usual formats (HEIC and TIFF in
    // Safari), so the list includes them only where they can be drawn.
    const decodes = await decodeProbe().catch(() => ({ heic: false, tiff: false }));
    const params = { drive: form.drive || null, folder: cleanFolder(form.folder) || null, kinds: form.kinds, mode: form.mode, decodes };
    lastStatus.current = 'idle';
    own((heard) => createPreviewRun({ params, list: listFor(params), work, onChange: heard })).start();
  };

  // A run kept from before has no control yet: one is made to carry it on.
  const ensureControl = () => control.current
    || own((heard) => createPreviewRun({ from: run, list: listFor(run.params), work, onChange: heard }));
  const resume = () => ensureControl().resume();
  const pause = () => control.current?.pause();
  const stop = () => ensureControl().stop();
  const again = () => {
    control.current = null;
    lastStatus.current = null;
    dropKept();
    setRun(null);
  };

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const handled = run ? run.done + run.skipped + run.failed : 0;
  const finished = run && (run.status === 'done' || run.status === 'stopped');
  const remaining = run && run.total != null ? (run.status === 'done' ? 0 : Math.max(0, run.total - handled)) : null;
  const leftOut = run ? leftOutWords(run.leftOut, mac) : null;
  const failures = run ? run.reasons.filter((r) => r.outcome === 'failed') : [];
  const skips = run ? run.reasons.filter((r) => r.outcome === 'skipped') : [];

  return (
    <AdminCard
      title="Regenerate"
      id="pv-run"
      hint="In this browser, three files at a time: a missing thumbnail from its original, missing smaller sizes or a placeholder from the thumbnail it has. Keep the page open while it runs; leaving it pauses the run, to carry on when you come back."
    >
      {!run && (
        <form className="admin-form" onSubmit={start} noValidate>
          <div className="admin-form-grid">
            <div className="admin-field">
              <label className="admin-field-label" htmlFor={`${id}-drive`}>Where</label>
              <select id={`${id}-drive`} className="input" value={form.drive} onChange={set('drive')}>
                <option value="">The whole library</option>
                {drives.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div className="admin-field">
              <label className="admin-field-label" htmlFor={`${id}-folder`}>Folder</label>
              <input id={`${id}-folder`} className="input" value={form.folder} onChange={set('folder')} placeholder="Campaigns/Spring" autoComplete="off" />
              <span className="admin-field-hint">This folder and the ones in it. Blank for all of it.</span>
            </div>
            <div className="admin-field">
              <label className="admin-field-label" htmlFor={`${id}-kinds`}>What</label>
              <select id={`${id}-kinds`} className="input" value={form.kinds} onChange={set('kinds')}>
                <option value="both">Pictures and videos</option>
                <option value="images">Pictures</option>
                <option value="videos">Videos</option>
              </select>
            </div>
          </div>
          <fieldset className="preview-modes">
            <legend className="admin-field-label">Which</legend>
            <label className="admin-check">
              <input type="radio" name={`${id}-mode`} value="missing" checked={form.mode === 'missing'} onChange={set('mode')} />
              <span>
                <strong>Missing only</strong>
                <span className="small muted">Files with no thumbnail, and thumbnails without their smaller sizes, their placeholder or a video’s player poster.</span>
              </span>
            </label>
            <label className="admin-check">
              <input type="radio" name={`${id}-mode`} value="everything" checked={form.mode === 'everything'} onChange={set('mode')} />
              <span>
                <strong>Everything</strong>
                <span className="small muted">Every preview in the scope drawn again from its original, replacing the one there — a cover someone chose for a video included.</span>
              </span>
            </label>
          </fieldset>
          <div className="admin-form-actions">
            <button type="submit" className="btn btn-primary">Regenerate</button>
          </div>
        </form>
      )}

      {run && (
        <div className="preview-run">
          <p className="preview-run-head" role="status" aria-live="polite">
            <strong>{STATUS[run.status] || 'Ready'}</strong>
            <span className="small muted"> {scopeWords(run.params, drives)}</span>
          </p>
          {!control.current && unfinished(run) && (
            <p className="small muted admin-note">This run was left part-way, when the page was closed or left. It carries on from where it was.</p>
          )}
          {run.total != null && run.total > 0 && (
            <Meter value={handled} max={run.total} label={`${num(handled)} of ${files(run.total)}`} />
          )}
          <dl className="preview-counts">
            <div><dt>Done</dt><dd>{num(run.done)}</dd></div>
            <div><dt>Skipped</dt><dd>{num(run.skipped)}</dd></div>
            <div><dt>Failed</dt><dd>{num(run.failed)}</dd></div>
            <div><dt>Remaining</dt><dd>{remaining == null ? '…' : num(remaining)}</dd></div>
            <div><dt>Downloaded</dt><dd>{fmtSize(run.bytes) || '0 B'}</dd></div>
          </dl>
          {run.current.length > 0 && (
            <p className="small preview-now">
              <span className="muted">Now: </span>
              {run.current.map((c, i) => (
                <span key={c.id}>
                  {i > 0 && ', '}
                  <span className="preview-now-name">{c.name}</span>
                  <span className="muted"> ({JOBS[c.job] || c.job})</span>
                </span>
              ))}
            </p>
          )}
          {run.done > 0 && jobWords(run.jobs) && <p className="small muted admin-note">Of those done: {jobWords(run.jobs)}.</p>}
          <p className="small muted admin-note">Downloaded counts the originals of pictures; a video is read only as far as the frame it is drawn from.</p>
          {leftOut && <p className="small muted admin-note">{leftOut}</p>}
          {run.status === 'error' && run.error && <p className="small admin-inline-error" role="alert">{run.error}</p>}

          {(failures.length > 0 || skips.length > 0) && (
            <ul className="preview-reasons">
              {[...failures, ...skips].map((r) => (
                <li key={`${r.outcome}:${r.reason}`}>
                  <details className="admin-disclosure">
                    <summary>
                      <span className={r.outcome === 'failed' ? 'preview-failed' : undefined}>{num(r.count)} {r.outcome}</span>: {r.reason}
                    </summary>
                    <ul className="preview-names">
                      {r.files.map((f) => (
                        <li key={f.id}><Link href={`/files/${encodeURIComponent(f.id)}`} className="truncate">{f.name}</Link></li>
                      ))}
                      {r.count > r.files.length && <li className="muted">and {num(r.count - r.files.length)} more</li>}
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
          )}

          <div className="admin-form-actions">
            {run.status === 'running' && <button type="button" className="btn" onClick={pause}>Pause</button>}
            {(run.status === 'paused' || run.status === 'error') && (
              <button type="button" className="btn btn-primary" onClick={resume}>{run.status === 'error' ? 'Try again' : 'Resume'}</button>
            )}
            {['running', 'pausing', 'paused', 'error'].includes(run.status) && (
              <button type="button" className="btn" onClick={stop}>Stop</button>
            )}
            {finished && <button type="button" className="btn btn-primary" onClick={again}>Start another</button>}
            {!control.current && unfinished(run) && <button type="button" className="btn btn-ghost" onClick={again}>Discard it</button>}
          </div>
        </div>
      )}
      {confirmElement}
    </AdminCard>
  );
}
