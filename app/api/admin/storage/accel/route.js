import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getStorageConfig, setStorageConfig, storageMode, s3SetAccelerate } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET → { enabled } current Transfer Acceleration flag. */
export async function GET() {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  const cfg = await getStorageConfig({ fresh: true });
  return NextResponse.json({ enabled: !!cfg.accelerate, available: storageMode(cfg) === 's3' && !cfg.endpoint });
}

/** POST { enabled } — toggle Transfer Acceleration on the bucket + persist the flag. */
export async function POST(req) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  const cfg = await getStorageConfig({ fresh: true });
  if (storageMode(cfg) !== 's3' || cfg.endpoint) {
    return NextResponse.json({ error: 'Transfer Acceleration needs an AWS S3 bucket (no custom endpoint).' }, { status: 400 });
  }
  let body = {};
  try { body = await req.json(); } catch {}
  const enabled = body.enabled !== false;
  try {
    await s3SetAccelerate(cfg, enabled);
    await setStorageConfig({ ...cfg, accelerate: enabled }, gate.email);
    return NextResponse.json({ ok: true, enabled });
  } catch (e) {
    const denied = /AccessDenied|not authorized/i.test(`${e?.name || ''} ${e?.message || ''}`);
    return NextResponse.json({
      error: denied
        ? 'This key isn’t allowed to change Transfer Acceleration (s3:PutAccelerateConfiguration). Ask the bucket owner to enable it, or add that permission.'
        : (e.message || 'Failed to update Transfer Acceleration.'),
    }, { status: denied ? 403 : 500 });
  }
}
