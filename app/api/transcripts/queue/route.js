import { NextResponse } from 'next/server';
import { listTranscriptJobs } from '@/lib/db';
import { resolveActor } from '@/lib/desktop-guard';
import { can } from '@/lib/authz';
import { isFeatureEnabled } from '@/lib/features';
import { QUEUE_LIMIT } from '@/lib/transcripts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body, status = 200, headers = {}) => NextResponse.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

/**
 * GET /api/transcripts/queue → { jobs: [{ fileId, name, mime, size, language, requestedAt }] }
 *
 * The jobs this caller's Mac could take: queued, or working on a lease that
 * has run out, on a video or audio file not in the trash, that they may
 * CHANGE — oldest request first, at most 10. Onyx for Mac polls it every
 * couple of minutes, and at once when the web nudges it.
 *
 * The same principal as everywhere (resolveActor: cookie or bearer), and the
 * same two rules as every other file path: the listing's access clause in
 * the query, then modifiableFileIds on what it returns (lib/db.js
 * listTranscriptJobs) — drives are boundaries here too. No URL is minted
 * here; a claim does that, for the one job it takes.
 *
 * Nothing to do reads as an empty list, not a refusal: the flag off, or a
 * role that cannot change files (a Viewer's Mac simply never gets work).
 */
export async function GET(req) {
  const actor = await resolveActor(req);
  if (actor.error) return actor.error;
  const { principal } = actor;
  if (!isFeatureEnabled(principal.flags, 'transcripts')) return json({ jobs: [] });
  const edit = can(principal, 'files.edit');
  if (!edit.ok) {
    // Degraded (the roles could not be read): retry, rather than an empty
    // queue that says there is nothing to do.
    if (edit.code === 'degraded') return json({ error: edit.reason, code: 'degraded' }, 503, { 'retry-after': '30' });
    return json({ jobs: [] });
  }

  let jobs;
  try {
    jobs = await listTranscriptJobs(principal, { limit: QUEUE_LIMIT });
  } catch (e) {
    console.warn('[transcripts/queue] could not read the queue:', e.message);
    return json({ error: 'The queue could not be read right now.' }, 503, { 'retry-after': '30' });
  }
  return json({
    jobs: jobs.map(({ file, language, requestedAt }) => ({
      fileId: file.id,
      name: file.name,
      mime: file.mime || null,
      size: file.size ?? null,
      language: language || null,
      requestedAt: requestedAt ? requestedAt.toISOString() : null,
    })),
  });
}
