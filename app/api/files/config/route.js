import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getStorageConfig, storageMode } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/files/config → { mode, bucket } — tells the client which upload path to use. */
export async function GET() {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const cfg = await getStorageConfig();
  const mode = storageMode(cfg);
  return NextResponse.json({ mode, bucket: mode === 's3' ? (cfg.bucket || null) : null });
}
