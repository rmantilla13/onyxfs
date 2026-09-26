import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { listVideosMissingFrameModel, frameModelSummary } from '@/lib/db';
import { effectiveKind } from '@/lib/media';
import { frameSources, probeFrameModel } from '@/lib/frame-probe';
import { mapLimit } from '@/lib/folder-ops';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Well inside maxDuration: the answer has to get back before the platform
// gives up on the request. A probe is a few small range reads, and a slow
// bucket can take the whole read timeout (lib/frame-probe.js) on one, so a
// batch is started only while there is time for it to finish.
const BUDGET_MS = 15_000;
const BATCH = 24;
const PARALLEL = 6;

/**
 * POST { after? } → { checked, found, unreadable, skipped, failed, after, done, summary }
 *
 * Admin → Usage's "Probe all videos": the frame model (exact rate, frame
 * count, start timecode) for every video from before uploads were probed,
 * read from its container the way the detail page's backfill reads one
 * (lib/frame-probe.js). Until a file has one, its comments count frames at
 * an assumed 30fps. Resumable, like the duplicate scan: each call works for a
 * few seconds, then returns `after` (the last id it looked at) for the next
 * to carry on from, until `done`. One pass looks at each row once:
 *
 *   found       recorded
 *   unreadable  read, with no rate in it (WebM, say) — marked, not retried
 *   skipped     not in storage the server can read
 *   failed      the read failed; left as it was for another pass
 *
 * Admins only. It reads every video in the library, whoever may open it, so
 * it is gated here rather than filtered per file; nothing it reads is
 * returned, only counts.
 */
export async function POST(req) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  let body = {};
  try { body = await req.json(); } catch {}

  const sources = await frameSources();
  const started = Date.now();
  let after = typeof body.after === 'string' ? body.after : '';
  const counts = { checked: 0, found: 0, unreadable: 0, skipped: 0, failed: 0 };
  let done = false;
  while (Date.now() - started < BUDGET_MS) {
    const rows = await listVideosMissingFrameModel({ after, limit: BATCH });
    if (!rows.length) { done = true; break; }
    const states = await mapLimit(rows, PARALLEL, async (f) => {
      // The query's idea of a video is close to effectiveKind's; this is exact.
      if (effectiveKind(f) !== 'video') return 'skipped';
      try { return (await probeFrameModel(f, { sources })).state; }
      catch { return 'failed'; }
    });
    for (const s of states) {
      counts.checked += 1;
      if (s === 'found') counts.found += 1;
      else if (s === 'unreadable') counts.unreadable += 1;
      else if (s === 'failed') counts.failed += 1;
      else counts.skipped += 1;
    }
    after = rows[rows.length - 1].id;
    if (rows.length < BATCH) { done = true; break; }
  }

  return NextResponse.json({ ...counts, after, done, summary: await frameModelSummary() });
}
