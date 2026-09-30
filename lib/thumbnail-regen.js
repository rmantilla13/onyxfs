// lib/thumbnail-regen.js — drawing a file's previews again, on purpose: a
// file's "Regenerate thumbnail", and each job of an Admin → Previews run.
//
// The drawing, uploading and recording are the ones every thumbnail goes
// through (lib/thumbnail-client.js). This adds what doing it deliberately
// needs: a fresh look at the file first, an original downloaded here so a
// run can count what it read, and the small jobs' answers as a run counts
// them (lib/preview-jobs.js jobOutcome). Browser-only; loaded when first
// needed, like the backfill.

import { makeThumbnail, recordThumbnail, makeSizes, makePlaceholder } from './thumbnail-client';
import { mergeBackfilled } from './backfill';
import { drawableKind } from './media';
import { decodeProbe } from './decode-probe';
import { cannotDraw, jobOutcome, failureReason } from './preview-jobs';

/**
 * The original, as makeThumbnail fetches one itself — with CORS, so the
 * canvas it is drawn on can be exported, and past the HTTP cache, where the
 * grid's copy without CORS may be — read here so each piece is counted.
 */
async function download(url, onBytes) {
  const r = await fetch(url, { mode: 'cors', cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const type = r.headers.get('content-type') || '';
  if (!r.body?.getReader) {
    const blob = await r.blob();
    onBytes?.(blob.size);
    return blob;
  }
  const reader = r.body.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    onBytes?.(value.byteLength);
  }
  return new Blob(parts, { type });
}

/**
 * Every preview of `file` drawn again from its original, replacing the ones
 * it has. For a video that is the automatic frame, over a cover someone
 * chose: choosing one is the cover dialog's (setVideoCover). Resolves the
 * row, signed; rejects with a message to show.
 *
 * `fresh` (the default) reads the file first: a new address for the
 * original, however long the page has been open, and whether this person
 * may change it — asked before anything is downloaded, as the backfill asks.
 * A run passes rows it has just listed, as an admin, who may.
 */
export async function redrawThumbnail(file, { onBytes, fresh = true } = {}) {
  let f = file;
  if (fresh) {
    const r = await fetch(`/api/files/${encodeURIComponent(file.id)}`, { cache: 'no-store' });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `Could not read the file (HTTP ${r.status}).`);
    if (!out.canWrite) throw new Error('You can view this file but not change its thumbnail.');
    f = { ...file, ...out.file };
  }
  const decodes = await decodeProbe().catch(() => ({}));
  const why = cannotDraw(f, { decodes });
  if (why) throw new Error(why);
  // A picture's original is read whole; a video's only as far as the frame,
  // by the <video> that seeks to it.
  const source = drawableKind(f, { probe: decodes }) === 'image' ? await download(f.url, onBytes) : f.url;
  const thumb = await makeThumbnail(source, f);
  if (!thumb) throw new Error('This browser cannot draw this file.');
  return recordThumbnail(f, thumb);
}

/**
 * One job of a run (lib/preview-runner.js `work`), for a row the candidates
 * route listed: { outcome: 'done' | 'skipped' | 'failed', row?, reason? }.
 */
export async function runPreviewJob(file, job, { onBytes } = {}) {
  try {
    if (job === 'redraw') return { outcome: 'done', row: await redrawThumbnail(file, { onBytes, fresh: false }) };
    if (job === 'sizes') return jobOutcome(job, await makeSizes(file));
    if (job === 'placeholder') return jobOutcome(job, await makePlaceholder(file));
    return { outcome: 'skipped', reason: 'Nothing to do.' };
  } catch (e) {
    return { outcome: 'failed', reason: failureReason(e, file) };
  }
}

/**
 * A redrawn row folded into the one on screen (mergeBackfilled), less a
 * large preview it no longer has: the old one was deleted with the
 * thumbnail it was drawn beside.
 */
export function mergeRedrawn(row, f) {
  const next = mergeBackfilled(row, f);
  if (next !== row && f && !f.posterKey) delete next.posterUrl;
  return next;
}
