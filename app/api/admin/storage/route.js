import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getStorageConfig, setStorageConfig, sanitizeStorageConfig, sanitizeStorageSubmission, s3TestConnection } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

  const current = await getStorageConfig({ fresh: true });
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
