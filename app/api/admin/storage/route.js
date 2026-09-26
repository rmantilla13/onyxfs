import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import {
  getStorageConfig, setStorageConfig, sanitizeStorageConfig, sanitizeStorageSubmission, s3TestConnection, s3SetAccelerate,
} from '@/lib/storage';
import { deploymentOrigins } from './origins';
import { storageLocationChange } from '@/lib/storage-presets';
import { libraryUsage } from '@/lib/db';
import { guardMove } from '@/lib/move-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vercel's default ceiling is 300s. Nothing here should take anywhere near
// that: every query in lib/db.js is bounded at 15s by the driver. A cap keeps
// a pathological request costing seconds instead of five minutes of a hung
// invocation — which is what the gateway timeouts on this route looked like.
export const maxDuration = 30;

/**
 * GET /api/admin/storage → sanitized config (no secret) + current mode, how
 * much the library holds — what a change of bucket or provider would leave
 * behind, for the confirm in front of it — and the origins Apply CORS
 * would allow, so the page can say which before anything is applied.
 *
 * Strict: a failed read is an error the page shows, not defaults that look
 * like "nothing is configured" and invite someone to fill the form in again.
 */
export async function GET(req) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  let cfg;
  try {
    cfg = await getStorageConfig({ fresh: true, strict: true });
  } catch (e) {
    return NextResponse.json({
      error: 'Could not read the storage settings: the database did not answer in time. Nothing has changed — try again.',
      code: 'read_failed',
      detail: e.message,
    }, { status: 503 });
  }
  const [library, corsOrigins] = await Promise.all([
    libraryUsage().catch(() => null),
    deploymentOrigins(req).catch(() => []),
  ]);
  return NextResponse.json({ config: sanitizeStorageConfig(cfg), library, corsOrigins });
}

/**
 * PUT /api/admin/storage  Body: { config, test?, confirmMove? }
 * Fields: provider, bucket, region, endpoint, accessKeyId, secretAccessKey,
 * prefix, roleArn, publicBaseUrl, accelerate (sanitizeStorageSubmission).
 * If `config.secretAccessKey` is empty/omitted, the existing stored secret is
 * preserved (so the admin doesn't have to re-paste it on every edit).
 * With test=true, validates the S3 connection before saving.
 *
 * Changing the provider, the bucket or the service while files are stored is
 * refused with 409 unless confirmMove is true. Nothing moves when the config
 * does: every stored file stays where it is, and this deployment starts
 * looking for it in the new place. The form asks first; this is the backstop
 * for anything that skipped the question.
 */
export async function PUT(req) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  // Whitelisted, because the form is populated from sanitizeStorageConfig and
  // therefore carries derived fields (hasSecret, mode) that must never become
  // stored state.
  const incoming = sanitizeStorageSubmission(body?.config);

  // Strict, and this is the load-bearing part. The form leaves the secret
  // blank to mean "keep the stored one", so the save depends on having read
  // the stored one. When that read merely FAILED, the old code received
  // defaults, could not tell them from "nothing configured", and wrote an
  // empty secret over a working bucket — every save during a slow database
  // quietly unconfigured the storage.
  let current;
  try {
    current = await getStorageConfig({ fresh: true, strict: true });
  } catch (e) {
    return NextResponse.json({
      error: 'Could not read the current storage configuration, so nothing was saved — '
           + 'saving now would overwrite it with blanks. The database did not answer in time; try again.',
      code: 'read_failed',
      detail: e.message,
    }, { status: 503 });
  }
  // Preserve the stored secret when the field comes back blank.
  if (!incoming.secretAccessKey) incoming.secretAccessKey = current.secretAccessKey;

  // Clean the stored side too, so a row written before the whitelist existed
  // loses its junk on the next save rather than carrying it forever.
  const before = sanitizeStorageSubmission(current);
  const merged = { ...before, ...incoming };

  // Fails closed (guardMove): a count that cannot be read saves nothing,
  // rather than reading as an empty library and letting the move through.
  const move = storageLocationChange(before, merged);
  const stop = await guardMove({
    changed: move.changed,
    confirmed: body.confirmMove,
    count: libraryUsage,
    message: (files) => `This library has ${files.toLocaleString('en-US')} file${files === 1 ? '' : 's'} in ${before.provider === 's3' ? `the bucket "${before.bucket}"` : 'Vercel Blob'}. `
      + 'They will not move. Confirm the change to save it anyway.',
  });
  if (stop) return NextResponse.json({ ...stop.body, changes: move.changes }, { status: stop.status });

  // Transfer Acceleration is AWS's, and only for a bucket addressed without
  // an endpoint. Turning it on in the config without turning it on at the
  // bucket would send every upload to an accelerate endpoint that refuses
  // them, so it is switched on at the bucket first, and not saved if that
  // fails. Turning it off only stops using it; the bucket setting is left.
  if (merged.accelerate && (merged.provider !== 's3' || merged.endpoint)) merged.accelerate = false;
  if (merged.accelerate && !before.accelerate) {
    try { await s3SetAccelerate(merged, true); }
    catch (e) {
      return NextResponse.json({
        error: `Transfer Acceleration could not be turned on for the bucket, so nothing was saved: ${e.message}`,
        code: 'accelerate_failed',
      }, { status: 400 });
    }
  }

  if (body.test && merged.provider === 's3') {
    try { await s3TestConnection(merged); }
    catch (e) { return NextResponse.json({ error: `Connection test failed: ${e.message}` }, { status: 400 }); }
  }

  const saved = await setStorageConfig(merged, gate.email);
  return NextResponse.json({ config: sanitizeStorageConfig(saved), tested: !!body.test });
}
