import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getStorageConfig, s3PresignPut, storageMode, cfgForFilespace } from '@/lib/storage';
import { getFilespaceForUser } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * POST /api/files/presign  Body: { filename, contentType, folder }
 * Returns { putUrl, publicUrl, key } for a direct browser → custom-bucket PUT.
 * `folder` is baked into the object key so the bucket mirrors Onyx's folders.
 * Only valid when storage mode is 's3'.
 */
export async function POST(req) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const cfg = await getStorageConfig();
  if (storageMode(cfg) !== 's3') {
    return NextResponse.json({ error: 'No custom bucket configured.', code: 'no_bucket' }, { status: 400 });
  }

  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }

  // Thumbnails go to a dedicated `_thumbs/` prefix — outside every filespace —
  // so they never show up as files in the listing or on a mounted drive.
  let scoped = cfg;
  let folder = body.folder;
  if (body.thumb) {
    scoped = { ...cfg, prefix: '_thumbs' };
    folder = undefined;
  } else if (body.filespaceId) {
    // Scope the upload to a filespace's bucket prefix when one is selected, so the
    // object lands exactly where the desktop app mounts it.
    const fs = await getFilespaceForUser(session.user.email, body.filespaceId);
    if (fs) scoped = cfgForFilespace(cfg, fs);
  }

  try {
    const out = await s3PresignPut(scoped, { filename: body.filename, contentType: body.contentType, folder });
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Could not presign upload.' }, { status: 500 });
  }
}
