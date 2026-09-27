import {
  getProxy, requestProxy, deleteProxy, reportProxyProgress, failProxy, finishProxy,
} from '@/lib/db';
import { openProxy, proxyBody, readJson, lost, json, dropProxyObject } from '@/lib/proxy-guard';
import { progressValue, failureMessage, LEASE_SECONDS } from '@/lib/proxies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A file's proxy rendition. Transcoding happens on a Mac running the desktop
 * app, never here (lib/proxies.js says why a Vercel function cannot do it): the
 * web asks for one (POST), a Mac takes the job (POST …/claim), reports on it
 * (PATCH) and says it landed (PUT), and anyone who can see the file reads the
 * job's state (GET).
 *
 * Every method takes the browser's session or the Mac's bearer token
 * (resolveActor: the same principal either way) and reads the `proxies` flag
 * itself. Everything but GET takes files.edit and write access to the file,
 * drives included, checked on every call — someone taken off a drive mid-job
 * cannot hand its result in (lib/proxy-guard.js).
 *
 * Nothing here names the object's key: the claim does, from a fresh uuid, and
 * PUT only says the transcode finished. So no request can point a file's proxy
 * at another object.
 */

/**
 * GET → { proxy: {…}, canRequest, canDelete }
 *
 * The detail page polls this while a job is queued or working, so it is
 * authorized every time, not once per page.
 */
export async function GET(req, { params }) {
  const g = await openProxy(req, params.id, 'read');
  if (g.error) return g.error;
  let row;
  try { row = await getProxy(g.file.id); } catch {
    return json({ error: 'The proxy could not be read right now.' }, 503);
  }
  return json(await proxyBody(g, row));
}

/**
 * POST → the GET body
 *
 * Ask for a proxy, or ask again — from any status. A finished proxy stays
 * playable until the new run replaces it; a Mac working on it loses the job
 * (its next PATCH or PUT is a 409). Re-requesting is how a file whose contents
 * were replaced gets a proxy of the new footage.
 */
export async function POST(req, { params }) {
  const g = await openProxy(req, params.id, 'request');
  if (g.error) return g.error;
  const row = await requestProxy(g.file.id, { requestedBy: g.email });
  // Nothing serves a proxy whose job is not `done`, so the previous run's
  // rendition is unreachable from the moment this row goes back to `queued` —
  // keeping the object would leak hundreds of megabytes per press of "Try
  // again". Best effort, and after the row: a bucket that cannot be reached is
  // not a reason to refuse the request.
  await dropProxyObject(row?.abandonedKey);
  return json(await proxyBody(g, row));
}

/**
 * DELETE → { ok: true }
 *
 * Forgets the job, and removes the rendition it pointed at — the row first, so a
 * bucket that cannot be reached leaves an orphaned object rather than a `done`
 * proxy whose URL 404s in the middle of playback.
 */
export async function DELETE(req, { params }) {
  const g = await openProxy(req, params.id, 'delete');
  if (g.error) return g.error;
  const { key } = await deleteProxy(g.file.id);
  await dropProxyObject(key);
  return json({ ok: true });
}

/**
 * PATCH { progress: 0.37 }                → { ok, leaseSeconds }
 *       { status: 'failed', error: 'why' } → { ok }
 *
 * From the Mac that claimed the job, and only while it is working and theirs;
 * otherwise 409 { code: 'lost' } and the Mac stops. A progress report renews
 * the lease for another ten minutes, which is the only thing that keeps a long
 * transcode from being taken over halfway through.
 */
export async function PATCH(req, { params }) {
  const g = await openProxy(req, params.id, 'report');
  if (g.error) return g.error;
  const read = await readJson(req);
  if (read.error) return read.error;
  const body = read.body;

  if (body.status === 'failed') {
    const row = await failProxy(g.file.id, { email: g.email, error: failureMessage(body.error) });
    return row ? json({ ok: true }) : lost();
  }
  if (body.status != null) return json({ error: 'The only status a report can set is "failed".' }, 400);
  const progress = progressValue(body.progress);
  if (progress == null) return json({ error: 'Send { "progress": 0..1 }, or { "status": "failed", "error": "…" }.' }, 400);
  const row = await reportProxyProgress(g.file.id, { email: g.email, progress });
  return row ? json({ ok: true, leaseSeconds: LEASE_SECONDS }) : lost();
}

/**
 * PUT { width, height, size, duration } → the GET body
 *
 * The rendition is in the bucket, under the key the claim handed out. From the
 * Mac that claimed the job, while it is still working and theirs (409
 * { code: 'lost' } otherwise).
 *
 * The four numbers are what the player needs before the first byte: the
 * dimensions size the element, `size` shows what the proxy saved, and
 * `duration` lets the scrubber exist before metadata loads. Every one is
 * optional — a worker that could not probe its own output should still be able
 * to say the transcode finished — but a value that is sent must be a real
 * number, because a NaN reaching the player is worse than a null.
 */
export async function PUT(req, { params }) {
  const g = await openProxy(req, params.id, 'submit');
  if (g.error) return g.error;
  const read = await readJson(req, { optional: true });
  if (read.error) return read.error;

  const facts = {};
  for (const [field, { int, max }] of Object.entries({
    width: { int: true, max: 100000 },
    height: { int: true, max: 100000 },
    size: { int: true, max: Number.MAX_SAFE_INTEGER },
    duration: { int: false, max: 86400 * 7 },
  })) {
    const raw = read.body[field];
    if (raw == null) { facts[field] = null; continue; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > max || (int && !Number.isInteger(n))) {
      return json({ error: `"${field}" must be a positive number, or left out.` }, 400);
    }
    facts[field] = n;
  }

  const row = await finishProxy(g.file.id, { email: g.email, ...facts });
  if (!row) return lost();
  return json(await proxyBody(g, row));
}
