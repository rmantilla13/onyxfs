import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getFileById, canAccessFile, buildPrincipal } from '@/lib/db';
import { getStorageConfig, storageMode, s3PresignGet } from '@/lib/storage';

export const runtime = 'nodejs';

/**
 * GET /api/files/[id]/download — force a direct download (not a new tab).
 * Same-origin link → redirects to a presigned GET that carries
 * Content-Disposition: attachment, so the browser saves the file. The cross-
 * origin `download` attribute on an <a> is ignored by browsers; this is the fix.
 */
export async function GET(_req, { params }) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const file = await getFileById(params.id);
  if (!file) return NextResponse.json({ error: 'File not found' }, { status: 404 });
  const principal = await buildPrincipal(session.user.email);
  if (!(await canAccessFile(file, principal))) return NextResponse.json({ error: 'No access' }, { status: 403 });

  if (file.storage === 's3' && file.storageKey) {
    try {
      const cfg = await getStorageConfig();
      if (storageMode(cfg) === 's3') {
        const url = await s3PresignGet(cfg, file.storageKey, { download: true, filename: file.name, expiresIn: 600 });
        return NextResponse.redirect(url);
      }
    } catch (e) {
      return NextResponse.json({ error: e.message || 'Could not prepare download.' }, { status: 500 });
    }
  }
  // Blob (or no bucket): best-effort redirect to the stored URL.
  return NextResponse.redirect(file.url);
}
