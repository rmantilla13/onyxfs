import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getFilespaceById } from '@/lib/db';
import { getStorageConfig, cfgForFilespace, s3Diagnostics } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Five checks, each a round trip to the bucket, as for Storage → Backend.
export const maxDuration = 60;

/**
 * POST → the storage diagnostics for one drive, as saved: the Storage
 * settings with the drive's bucket, folder and region laid over them, and
 * its own keys and endpoint when it has them (cfgForFilespace — the same
 * config the web and the desktop mint use). The write probe lands under the
 * drive's own folder, so "Write access" answers for the drive, not the
 * library.
 *
 * Only the saved drive is tested. Its secret never leaves the server, so a
 * draft from the browser could not be tested honestly without it.
 */
export async function POST(req, { params }) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  const fs = params?.id ? await getFilespaceById(params.id) : null;
  if (!fs) return NextResponse.json({ error: 'Drive not found' }, { status: 404 });

  let stored;
  try {
    stored = await getStorageConfig({ fresh: true, strict: true });
  } catch (e) {
    return NextResponse.json({
      provider: 'unknown',
      label: 'unknown',
      checks: [{
        id: 'config', label: 'Configuration', status: 'fail',
        detail: `Could not read the saved storage settings: ${e.message}`,
        fix: 'The database did not answer in time. This says nothing about the bucket — try again in a moment.',
      }],
    });
  }

  let origin = '';
  try { origin = new URL(req.url).origin; } catch { /* leave blank */ }
  return NextResponse.json(await s3Diagnostics(cfgForFilespace(stored, fs), { origin }));
}
