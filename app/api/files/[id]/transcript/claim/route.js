import { claimTranscript, failTranscript } from '@/lib/db';
import { presignFileUrls } from '@/lib/storage';
import { openTranscript, readJson, json } from '@/lib/transcript-guard';
import { normalizeDevice, LEASE_SECONDS } from '@/lib/transcripts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The Mac downloads the whole file before it transcribes, and a long master
// on a slow line takes a while; a range retry after a dropped connection
// reuses the URL. The playable-video window, as /api/space/files gives a
// File Provider — well past the hour the contract asks for.
const DOWNLOAD_URL_TTL = 21600;

/**
 * POST /api/files/[id]/transcript/claim  Body: { device: "Ricky's MacBook Pro" }
 *   → { fileId, name, mime, size, language, sourceKey, downloadUrl, leaseSeconds }
 *
 * A Mac takes a job. Atomic (lib/db.js claimTranscript): it succeeds only on
 * a job that is queued, or working on a lease that has run out, so two Macs
 * asking at once cannot both have it. 409 { code: 'taken' } when another
 * holds it; 404 when there is no job.
 *
 * AUTHORIZE → FILTER → PRESIGN. The caller is held to the same checks as a
 * request (files.edit, write access to the file, drives included); the job
 * is claimed; and only then is the download URL minted, for the key the
 * claim recorded.
 */
export async function POST(req, { params }) {
  const g = await openTranscript(req, params.id, 'claim');
  if (g.error) return g.error;
  const read = await readJson(req, { optional: true });
  if (read.error) return read.error;
  const device = normalizeDevice(read.body.device);

  const claimed = await claimTranscript(g.file.id, { email: g.email, device, sourceKey: g.file.storageKey || null });
  if (claimed.taken) return json({ error: 'Another Mac is transcribing this file.', code: 'taken' }, 409);
  if (claimed.missing) return json({ error: 'There is no transcription job for this file.' }, 404);
  const job = claimed.row;

  const [signed] = await presignFileUrls([g.file], { expiresIn: DOWNLOAD_URL_TTL, previews: false });
  if (!signed?.url) {
    // Nothing to download: the job fails now, where everyone can see why,
    // rather than coming back to the queue for ever.
    const why = 'This file has no stored copy to download.';
    await failTranscript(g.file.id, { email: g.email, error: why }).catch(() => {});
    return json({ error: why, code: 'unavailable' }, 409);
  }

  return json({
    fileId: g.file.id,
    name: g.file.name,
    mime: g.file.mime || null,
    size: g.file.size ?? null,
    language: job.language || null,
    sourceKey: job.sourceKey,
    downloadUrl: signed.url,
    leaseSeconds: LEASE_SECONDS,
  });
}
