import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/session';
import { getStorageConfig, storageMode } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/files/config → { mode, bucket } — tells the client which upload path to use. */
export async function GET() {
  if (!(await getSessionUser())) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const cfg = await getStorageConfig();
  const mode = storageMode(cfg);
  return NextResponse.json({ mode, bucket: mode === 's3' ? (cfg.bucket || null) : null });
}
