import { NextResponse } from 'next/server';
import { resolveShareAccess } from '@/lib/share-access';
import { getStorageConfig, storageMode, s3PresignGet } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /s/<token>/download — the shared file, as an attachment. The same
 * decision as the page (lib/share-access), made again rather than trusted
 * from having rendered it: the link may have been revoked, expired or
 * re-passworded since. Anyone not let in is sent to the page, which says why.
 */
export async function GET(req, { params }) {
  const { token } = params;
  const access = await resolveShareAccess(token);
  if (access.state === 'signin') {
    return NextResponse.redirect(new URL(`/signin?callbackUrl=${encodeURIComponent(`/s/${token}`)}`, req.url));
  }
  if (access.state !== 'ok') return NextResponse.redirect(new URL(`/s/${token}`, req.url));

  const { file } = access;
  if (file.storage === 's3' && file.storageKey) {
    try {
      const cfg = await getStorageConfig();
      if (storageMode(cfg) === 's3') {
        const url = await s3PresignGet(cfg, file.storageKey, { download: true, filename: file.name, expiresIn: 600 });
        return NextResponse.redirect(url);
      }
    } catch (e) {
      return NextResponse.json({ error: e.message || 'Could not prepare the download.' }, { status: 500 });
    }
  }
  return NextResponse.redirect(file.url);
}
