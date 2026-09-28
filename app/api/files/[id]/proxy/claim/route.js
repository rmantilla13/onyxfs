import { randomUUID } from 'node:crypto';
import { claimProxy, failProxy } from '@/lib/db';
import { presignFileUrls, getStorageConfig, storageMode, s3PresignProxyPut } from '@/lib/storage';
import { openProxy, readJson, json } from '@/lib/proxy-guard';
import { proxyKeyFor } from '@/lib/media';
import { normalizeDevice, proxySpec, LEASE_SECONDS, PROXY_MAX_PUT_BYTES, PROXY_MIME } from '@/lib/proxies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The Mac reads the whole master to transcode it, and a long one on a slow line
// takes a while; a range retry after a dropped connection reuses the URL. Six
// hours — the same window a transcript claim gets, and the same window the
// upload URL gets, since the upload happens when the transcode ends.
const URL_TTL = 21600;

/**
 * POST /api/files/[id]/proxy/claim  Body: { device: "Ricky's MacBook Pro" }
 *   → { fileId, name, mime, size, sourceKey, sourceHeight, spec, maxBytes,
 *       downloadUrl, uploadUrl, proxyKey, leaseSeconds }
 *
 * A Mac takes a job. Atomic (lib/db.js claimProxy): it succeeds only on a job
 * that is queued, or working on a lease that has run out, so two Macs asking at
 * once cannot both have it. 409 { code: 'taken' } when another holds it; 404
 * when there is no job.
 *
 * AUTHORIZE → FILTER → PRESIGN. The caller is held to the same checks as a
 * request (files.edit, write access to the file, drives included); the job is
 * claimed, which is where the proxy's key is minted; and only then are the two
 * URLs signed — the download for the key the claim recorded, the upload for the
 * key it named. The worker never chooses either.
 *
 * `spec` is the rendition the server decided on (lib/proxies.js proxySpec) from
 * the source's own height, so the decision lives in one place and a worker
 * cannot quietly ship 4K. `maxBytes` is the single-PUT ceiling the upload URL
 * carries; over it the worker reports a failure rather than a truncated file.
 */
export async function POST(req, { params }) {
  const g = await openProxy(req, params.id, 'claim');
  if (g.error) return g.error;
  const read = await readJson(req, { optional: true });
  if (read.error) return read.error;
  const device = normalizeDevice(read.body.device);

  const cfg = await getStorageConfig();
  if (storageMode(cfg) !== 's3') {
    return json({ error: 'No custom bucket configured, so there is nowhere to put a proxy.', code: 'no_bucket' }, 409);
  }

  // Named before the claim so the claim can record it, but from a uuid and
  // nothing sent: a fresh key per claim, so a re-request is never served a
  // cached copy of the previous run and a late worker writing to its own
  // expired key cannot overwrite the newer rendition.
  const proxyKey = proxyKeyFor(randomUUID());

  const claimed = await claimProxy(g.file.id, {
    email: g.email, device, sourceKey: g.file.storageKey || null, proxyKey,
  });
  if (claimed.taken) return json({ error: 'Another Mac is transcoding this file.', code: 'taken' }, 409);
  if (claimed.missing) return json({ error: 'There is no proxy job for this file.' }, 404);
  const job = claimed.row;

  const [signed] = await presignFileUrls([g.file], { expiresIn: URL_TTL, previews: false });
  if (!signed?.url) {
    // Nothing to download: the job fails now, where everyone can see why,
    // rather than coming back to the queue for ever.
    const why = 'This file has no stored copy to transcode.';
    await failProxy(g.file.id, { email: g.email, error: why }).catch(() => {});
    return json({ error: why, code: 'unavailable' }, 409);
  }

  let upload;
  try {
    upload = await s3PresignProxyPut(cfg, job.proxyKey, { expiresIn: URL_TTL });
  } catch (e) {
    const why = `The proxy could not be given somewhere to land: ${e.message}`;
    await failProxy(g.file.id, { email: g.email, error: why }).catch(() => {});
    return json({ error: why, code: 'unavailable' }, 503);
  }

  const sourceHeight = Number(g.file.metadata?.height) || null;
  return json({
    fileId: g.file.id,
    name: g.file.name,
    mime: g.file.mime || null,
    size: g.file.size ?? null,
    sourceKey: job.sourceKey,
    sourceHeight,
    spec: proxySpec({ height: sourceHeight }),
    outputMime: PROXY_MIME,
    maxBytes: PROXY_MAX_PUT_BYTES,
    downloadUrl: signed.url,
    uploadUrl: upload.putUrl,
    proxyKey: job.proxyKey,
    leaseSeconds: LEASE_SECONDS,
  });
}
