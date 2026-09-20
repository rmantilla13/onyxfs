import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getStorageConfig, s3Diagnostics } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Five checks, each a round trip to the bucket. The default 10s is not enough
// on a cold connection to a distant region.
export const maxDuration = 60;

/**
 * POST — run the storage diagnostics.
 *
 * Body may carry a draft `config`, so an admin can verify a bucket BEFORE
 * saving it over a working one. A blank secret in the draft means "keep the
 * stored one", matching the save behaviour, so the field does not have to be
 * re-pasted to test an unrelated edit.
 */
export async function POST(req) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  let body = {};
  try { body = await req.json(); } catch { /* no draft — test what is saved */ }

  const stored = await getStorageConfig();
  const draft = body?.config && typeof body.config === 'object' ? body.config : {};
  const cfg = { ...stored, ...draft };
  if (!draft.secretAccessKey) cfg.secretAccessKey = stored.secretAccessKey;

  let origin = '';
  try { origin = new URL(req.url).origin; } catch { /* leave blank */ }

  const result = await s3Diagnostics(cfg, { origin });
  return NextResponse.json(result);
}
