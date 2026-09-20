import { NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/admin-guard';
import { listConfigKeys, setConfigOverride, clearConfigOverride } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET → every editable key with its presence and source. NEVER a secret value:
 * the response carries { set, secret, source } and only inlines `value` for
 * keys explicitly marked non-secret.
 */
export async function GET() {
  const guard = await requireSuperAdmin();
  if (guard.error) return guard.error;
  return NextResponse.json({ keys: await listConfigKeys() });
}

/** PUT { key, value } — override an env var from the panel. */
export async function PUT(req) {
  const guard = await requireSuperAdmin();
  if (guard.error) return guard.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  try {
    await setConfigOverride(body.key, body.value, guard.email);
    return NextResponse.json({ ok: true, keys: await listConfigKeys() });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}

/** DELETE ?key= — clear the override, reverting to the real env var. */
export async function DELETE(req) {
  const guard = await requireSuperAdmin();
  if (guard.error) return guard.error;
  const key = new URL(req.url).searchParams.get('key');
  try {
    await clearConfigOverride(key);
    return NextResponse.json({ ok: true, keys: await listConfigKeys() });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
