import {
  getTranscript, requestTranscript, deleteTranscript, reportTranscriptProgress, failTranscript, submitTranscript,
} from '@/lib/db';
import { openTranscript, transcriptBody, readJson, lost, json } from '@/lib/transcript-guard';
import {
  normalizeLanguage, normalizeSegments, normalizeEngine, normalizeSourceKey, segmentsText, progressValue, failureMessage,
  LEASE_SECONDS,
} from '@/lib/transcripts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A file's transcript. Transcription happens on a Mac running the desktop
 * app, never here (lib/transcripts.js): the web asks for one (POST), a Mac
 * takes the job (POST …/claim), reports on it (PATCH) and hands in the
 * result (PUT), and anyone who can see the file reads it (GET).
 *
 * Every method takes the browser's session or the Mac's bearer token
 * (resolveActor: the same principal either way) and reads the `transcripts`
 * flag itself. Everything but GET takes files.edit and write access to the
 * file, drives included, checked on every call — someone taken off a drive
 * mid-job cannot hand its result in (lib/transcript-guard.js).
 */

/**
 * GET → { transcript: {…} | null, canRequest, canDelete }
 *
 * The web polls this every few seconds while a job is queued or working, so
 * it is authorized every time, not once per page.
 */
export async function GET(req, { params }) {
  const g = await openTranscript(req, params.id, 'read');
  if (g.error) return g.error;
  let row;
  try { row = await getTranscript(g.file.id); } catch {
    return json({ error: 'The transcript could not be read right now.' }, 503);
  }
  return json(transcriptBody(g, row));
}

/**
 * POST { language?: "en-US" | null } → the GET body
 *
 * Ask for a transcript, or ask again — from any status. The previous
 * segments stay until a new run replaces them; a Mac working on it loses
 * the job (its next PATCH or PUT is a 409).
 */
export async function POST(req, { params }) {
  const g = await openTranscript(req, params.id, 'request');
  if (g.error) return g.error;
  const read = await readJson(req, { optional: true });
  if (read.error) return read.error;
  const language = normalizeLanguage(read.body.language);
  if (language.error) return json({ error: language.error }, 400);
  const row = await requestTranscript(g.file.id, { language: language.value, requestedBy: g.email });
  return json(transcriptBody(g, row));
}

/** DELETE → { ok: true } */
export async function DELETE(req, { params }) {
  const g = await openTranscript(req, params.id, 'delete');
  if (g.error) return g.error;
  await deleteTranscript(g.file.id);
  return json({ ok: true });
}

/**
 * PATCH { progress: 0.37 }                       → { ok, leaseSeconds }
 *       { status: 'failed', error: 'why' }        → { ok }
 *
 * From the Mac that claimed the job, and only while it is working and
 * theirs; otherwise 409 { code: 'lost' } and the Mac stops. A progress
 * report renews the lease for another 10 minutes.
 */
export async function PATCH(req, { params }) {
  const g = await openTranscript(req, params.id, 'report');
  if (g.error) return g.error;
  const read = await readJson(req);
  if (read.error) return read.error;
  const body = read.body;

  if (body.status === 'failed') {
    const row = await failTranscript(g.file.id, { email: g.email, error: failureMessage(body.error) });
    return row ? json({ ok: true }) : lost();
  }
  if (body.status != null) return json({ error: 'The only status a report can set is "failed".' }, 400);
  const progress = progressValue(body.progress);
  if (progress == null) return json({ error: 'Send { "progress": 0..1 }, or { "status": "failed", "error": "…" }.' }, 400);
  const row = await reportTranscriptProgress(g.file.id, { email: g.email, progress });
  return row ? json({ ok: true, leaseSeconds: LEASE_SECONDS }) : lost();
}

/**
 * PUT { segments: [{ s, e, t }], resultLanguage, engine, sourceKey } → the GET body
 *
 * The result, from the Mac that claimed the job, while it is still working
 * and theirs (409 { code: 'lost' } otherwise). Checked in full first —
 * 400 names the first thing wrong — and stored as sent, in time order.
 */
export async function PUT(req, { params }) {
  const g = await openTranscript(req, params.id, 'submit');
  if (g.error) return g.error;
  const read = await readJson(req);
  if (read.error) return read.error;
  const body = read.body;

  const segs = normalizeSegments(body.segments);
  if (segs.error) return json({ error: segs.error }, 400);
  const resultLanguage = normalizeLanguage(body.resultLanguage);
  if (resultLanguage.error) return json({ error: resultLanguage.error }, 400);
  const engine = normalizeEngine(body.engine);
  if (engine.error) return json({ error: engine.error }, 400);
  const sourceKey = normalizeSourceKey(body.sourceKey);
  if (sourceKey.error) return json({ error: sourceKey.error }, 400);

  const row = await submitTranscript(g.file.id, {
    email: g.email,
    segments: segs.segments,
    text: segmentsText(segs.segments),
    resultLanguage: resultLanguage.value,
    engine: engine.value,
    sourceKey: sourceKey.value,
  });
  if (!row) return lost();
  return json(transcriptBody(g, row));
}
