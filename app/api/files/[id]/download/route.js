import { NextResponse } from 'next/server';
import { getFileById, canAccessFile } from '@/lib/db';
import { requirePrincipal } from '@/lib/authz';
import { getStorageConfig, storageMode, s3PresignGet, storageForKey, ORIGINAL_URL_TTL } from '@/lib/storage';

export const runtime = 'nodejs';

/**
 * GET /api/files/[id]/download — force a direct download (not a new tab).
 * Same-origin link → redirects to a presigned GET that carries
 * Content-Disposition: attachment, so the browser saves the file. The cross-
 * origin `download` attribute on an <a> is ignored by browsers; this is the fix.
 *
 * The URL lasts as long as a player's (ORIGINAL_URL_TTL, six hours), not ten
 * minutes: a browser resumes an interrupted download by asking for the same
 * URL again, and a large one cut off after ten minutes could only start over.
 * The cost is the one playback already pays — a URL handed out keeps working
 * for up to six hours after the access behind it is taken away.
 */
export async function GET(_req, { params }) {
  const g = await requirePrincipal();
  if (g.error) return g.error;

  const file = await getFileById(params.id);
  if (!file) return NextResponse.json({ error: 'File not found' }, { status: 404 });
  if (!(await canAccessFile(file, g.principal))) return NextResponse.json({ error: 'No access' }, { status: 403 });

  if (file.storage === 's3' && file.storageKey) {
    try {
      const cfg = await getStorageConfig();
      if (storageMode(cfg) === 's3') {
        // Signed where the object is: a drive in a bucket of its own keeps it there.
        const url = await s3PresignGet(await storageForKey(cfg, file.storageKey), file.storageKey, { download: true, filename: file.name, expiresIn: ORIGINAL_URL_TTL });
        return NextResponse.redirect(url);
      }
    } catch (e) {
      return NextResponse.json({ error: e.message || 'Could not prepare download.' }, { status: 500 });
    }
  }
  // Blob (or no bucket): best-effort redirect to the stored URL.
  return NextResponse.redirect(file.url);
}
