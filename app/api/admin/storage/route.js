import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getStorageConfig, setStorageConfig, sanitizeStorageConfig, sanitizeStorageSubmission, s3TestConnection } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vercel's default ceiling is 300s. Nothing here should take anywhere near
// that: every query in lib/db.js is bounded at 15s by the driver. A cap keeps
// a pathological request costing seconds instead of five minutes of a hung
// invocation — which is what the gateway timeouts on this route looked like.
export const maxDuration = 30;

/** GET /api/admin/storage → sanitized config (no secret) + current mode. */
export async function GET() {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  const cfg = await getStorageConfig({ fresh: true });
  return NextResponse.json({ config: sanitizeStorageConfig(cfg) });
}

/**
 * PUT /api/admin/storage  Body: { config, test? }
 * If `config.secretAccessKey` is empty/omitted, the existing stored secret is
 * preserved (so the admin doesn't have to re-paste it on every edit).
 * With test=true, validates the S3 connection before saving.
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
  const merged = { ...sanitizeStorageSubmission(current), ...incoming };

  if (body.test && merged.provider === 's3') {
    try { await s3TestConnection(merged); }
    catch (e) { return NextResponse.json({ error: `Connection test failed: ${e.message}` }, { status: 400 }); }
  }

  const saved = await setStorageConfig(merged, gate.email);
  return NextResponse.json({ config: sanitizeStorageConfig(saved), tested: !!body.test });
}
