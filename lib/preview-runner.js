// lib/preview-runner.js — a run of Admin → Previews: files paged in from the
// server, each given its job (lib/preview-jobs.js previewJob) and done in
// this browser, a few at a time.
//
// No DOM and no network of its own. `list` fetches a page of files and
// `work` does one job — the page hands in lib/thumbnail-regen.js — so the run
// itself is plain logic the tests drive with fakes (test/preview-runner.test.js):
// which job each file gets, how many go at once, pausing and stopping, what
// is counted, and where a run that was left can pick up again.

import { previewJob, skipReason, failureReason } from './preview-jobs.js';

/**
 * Jobs under way at once, and how many of them may be full redraws: each of
 * those decodes an original — a picture of up to 50 MB, hundreds of
 * megabytes of pixels — in this tab. The small jobs read a thumbnail.
 */
export const RUN_PARALLEL = 3;
export const RUN_REDRAWS = 2;
/** Files named under each reason in the list at the end; the count goes on past them. */
export const NAMES_PER_REASON = 50;
// Files listed longer ago than this are listed again when a run resumes:
// their signed addresses may not have outlasted the pause.
const RELIST_AFTER_MS = 10 * 60_000;
// Downloads report in small pieces; the total is passed on at most this often.
const BYTES_EVERY_MS = 250;

const UNDER_WAY = new Set(['running', 'pausing', 'stopping']);

/**
 * A run's state, as onChange hands it over and a page keeps it:
 *   status   'idle'; 'running', 'pausing' → 'paused', 'stopping' → 'stopped',
 *            'done' when every file has been dealt with, 'error' when a page
 *            of files could not be listed (resuming lists it again). The
 *            -ing states wait for the jobs under way.
 *   params   what it is over: { drive, folder, kinds, mode, decodes }
 *   total    the files it will be handed, as counted when it began; null
 *            until the first page says
 *   leftOut  { heic, tiff, never }: files it will not be handed, because
 *            this browser cannot draw them
 *   done, skipped, failed   files dealt with, by outcome
 *   jobs     { redraw, sizes, placeholder }: the done ones, by job
 *   bytes    what the jobs downloaded, where they count it
 *   current  [{ id, name, job }]: the jobs under way
 *   reasons  [{ outcome, reason, count, files: [{ id, name }] }]: why files
 *            were skipped or failed, grouped, NAMES_PER_REASON names each
 *   after    every file up to this id has been dealt with — where the run
 *            picks up if it is left
 *   error    why the list stopped, for 'error'
 */
export function initialRunState(params = {}) {
  return {
    status: 'idle', params, total: null, leftOut: null,
    done: 0, skipped: 0, failed: 0, jobs: { redraw: 0, sizes: 0, placeholder: 0 }, bytes: 0,
    current: [], reasons: [], after: '', error: null,
  };
}

/** Whether a kept state is a run with files still to go: one to offer to resume. */
export function unfinished(state) {
  return !!state && (UNDER_WAY.has(state.status) || state.status === 'paused' || state.status === 'error');
}

/**
 * A kept state (a page left mid-run, say) as a run can carry on from it:
 * nothing under way any more, and one that was not finished paused where
 * it was left.
 */
export function carriedOver(saved) {
  if (!saved || typeof saved !== 'object' || !saved.params) return null;
  const s = { ...initialRunState(saved.params), ...saved, current: [], error: null };
  if (unfinished(saved)) s.status = 'paused';
  return s;
}

/**
 * createPreviewRun({ params, list, work, onChange, from }) → { start, pause, resume, stop, state }
 *
 *   list(after)                → { files, after, done, counts? }: the page of
 *                                files after `after`; the first one's
 *                                `counts` is { total, heic, tiff, never }
 *   work(file, job, { onBytes }) → { outcome: 'done' | 'skipped' | 'failed', reason? }
 *   onChange(state)            a fresh copy of the state after each change
 *   from                       a kept state to carry on from (carriedOver)
 *
 * start() begins a new run; resume() carries on a paused one (or one whose
 * list failed); pause() and stop() let the jobs under way finish. A job
 * that throws is a failure with the error's words (failureReason).
 */
export function createPreviewRun({
  params = {}, list, work, onChange = () => {}, from = null,
  parallel = RUN_PARALLEL, redraws = RUN_REDRAWS, now = Date.now,
} = {}) {
  const s = (from && carriedOver(from)) || initialRunState(params);
  // Files listed and not yet taken, the cursor of the next page, whether the
  // last page has been listed, and the page being listed now.
  let buffer = [];
  let pageAfter = s.after || '';
  let exhausted = false;
  let listing = null;
  let listedAt = 0;
  // Ids taken, in the order they were listed (id order), until every one
  // before them is dealt with: what moves `after` forward.
  const order = [];
  const dealt = new Set();
  let workers = 0;
  let redrawing = 0;
  const waiting = [];
  let bytesTimer = null;

  const snapshot = () => ({
    ...s,
    jobs: { ...s.jobs },
    leftOut: s.leftOut ? { ...s.leftOut } : null,
    current: s.current.map((c) => ({ ...c })),
    reasons: s.reasons.map((r) => ({ ...r, files: r.files.map((f) => ({ ...f })) })),
  });
  const emit = () => onChange(snapshot());

  const onBytes = (n) => {
    s.bytes += Math.max(0, Number(n) || 0);
    if (!bytesTimer) bytesTimer = setTimeout(() => { bytesTimer = null; emit(); }, BYTES_EVERY_MS);
  };

  // A full redraw waits for one of `redraws` places; a finished one hands its
  // place straight to the next in line.
  const place = () => {
    if (redrawing < redraws) { redrawing += 1; return Promise.resolve(); }
    return new Promise((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else redrawing -= 1;
  };

  function addReason(outcome, reason, file) {
    let r = s.reasons.find((x) => x.outcome === outcome && x.reason === reason);
    if (!r) {
      r = { outcome, reason, count: 0, files: [] };
      s.reasons.push(r);
    }
    r.count += 1;
    if (r.files.length < NAMES_PER_REASON) r.files.push({ id: file.id, name: file.name || file.id });
  }

  function settle(file, job, result) {
    const outcome = result?.outcome === 'done' || result?.outcome === 'failed' ? result.outcome : 'skipped';
    if (outcome === 'done') {
      s.done += 1;
      if (job) s.jobs[job] = (s.jobs[job] || 0) + 1;
    } else {
      s[outcome] += 1;
      addReason(outcome, result?.reason || (outcome === 'failed' ? 'Something went wrong.' : 'Skipped.'), file);
    }
    dealt.add(file.id);
    while (order.length && dealt.has(order[0])) {
      s.after = order.shift();
      dealt.delete(s.after);
    }
    emit();
  }

  // Once no worker is left: a pause or a stop has landed, or every file has
  // been dealt with.
  function landed() {
    if (workers > 0) return;
    if (s.status === 'pausing') s.status = 'paused';
    else if (s.status === 'stopping') s.status = 'stopped';
    else if (s.status === 'running' && exhausted && !buffer.length) s.status = 'done';
    else return;
    emit();
  }

  // A page may hold no files and still not be the last: the server looks
  // through its rows a window at a time (lib/db.js listPreviewCandidates).
  // One that neither ends the list nor moves past `after` would be asked for
  // again for ever, and ends it instead.
  function listPage() {
    listing ||= (async () => {
      try {
        const from = pageAfter;
        const page = await list(from);
        const files = Array.isArray(page?.files) ? page.files : [];
        if (page?.counts && s.total == null) {
          const c = page.counts;
          s.total = Number(c.total) || 0;
          s.leftOut = { heic: Number(c.heic) || 0, tiff: Number(c.tiff) || 0, never: Number(c.never) || 0 };
        }
        buffer.push(...files);
        pageAfter = page?.after || (files.length ? files[files.length - 1].id : from);
        exhausted = !!page?.done || (!files.length && pageAfter === from);
        listedAt = now();
        emit();
      } finally {
        listing = null;
      }
    })();
    return listing;
  }

  // The next file to deal with, or null when there are none left or the run
  // has stopped taking them.
  async function next() {
    for (;;) {
      if (s.status !== 'running') return null;
      if (buffer.length) {
        const file = buffer.shift();
        order.push(file.id);
        return file;
      }
      if (exhausted) return null;
      try {
        await listPage();
      } catch (e) {
        if (s.status === 'running') {
          s.status = 'error';
          s.error = e?.message || 'The files could not be listed.';
          emit();
        }
        return null;
      }
    }
  }

  async function dealWith(file) {
    const opts = { mode: s.params.mode, decodes: s.params.decodes || {} };
    const job = previewJob(file, opts);
    if (!job) {
      settle(file, null, { outcome: 'skipped', reason: skipReason(file, opts) });
      return;
    }
    if (job === 'redraw') await place();
    const entry = { id: file.id, name: file.name || file.id, job };
    s.current.push(entry);
    emit();
    let result;
    try {
      result = await work(file, job, { onBytes });
    } catch (e) {
      result = { outcome: 'failed', reason: failureReason(e, file) };
    } finally {
      if (job === 'redraw') release();
      s.current = s.current.filter((c) => c !== entry);
    }
    settle(file, job, result);
  }

  async function worker() {
    workers += 1;
    try {
      for (let file = await next(); file; file = await next()) await dealWith(file);
    } finally {
      workers -= 1;
      landed();
    }
  }

  const spawn = () => {
    for (let i = workers; i < parallel; i += 1) worker();
  };

  return {
    start() {
      if (s.status !== 'idle') return;
      s.status = 'running';
      emit();
      spawn();
    },
    resume() {
      if (s.status !== 'paused' && s.status !== 'pausing' && s.status !== 'error') return;
      // Whatever is left of a page listed long ago is listed again, from the
      // last file taken: its signed addresses may not have lasted.
      if (buffer.length && now() - listedAt > RELIST_AFTER_MS) {
        buffer = [];
        pageAfter = order.length ? order[order.length - 1] : s.after;
        exhausted = false;
      }
      s.status = 'running';
      s.error = null;
      emit();
      spawn();
    },
    pause() {
      if (s.status !== 'running') return;
      s.status = 'pausing';
      emit();
      landed();
    },
    stop() {
      if (!UNDER_WAY.has(s.status) && s.status !== 'paused' && s.status !== 'error') return;
      if (s.status === 'stopping') return;
      s.status = 'stopping';
      emit();
      landed();
    },
    state: snapshot,
  };
}
