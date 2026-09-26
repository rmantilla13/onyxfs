import { NextResponse } from 'next/server';
import { handleUpload } from '@vercel/blob/client';
import { usedBytesBy } from '@/lib/db';
import { requirePrincipal, can, refusal, uploadAllowance } from '@/lib/authz';

export const runtime = 'nodejs';

// Vercel Blob's own ceiling for a client upload through this route.
const BLOB_MAX_BYTES = 1024 * 1024 * 1024; // 1 GB

/**
 * POST /api/files/upload — Vercel Blob client-upload token for the library
 * (default backend). Broad content types, large size cap. Used when storage
 * mode is 'blob'; the S3 path uses /api/files/presign instead.
 *
 * The token carries the most this person may upload right now:
 * min(1 GB, their largest upload, what is left of their quota). Blob mode
 * has no drives, so that and the role's files.upload are the whole check;
 * POST /api/files checks the recorded size again.
 */
export async function POST(req) {
  const g = await requirePrincipal();
  if (g.error) return g.error;
  const { principal, email } = g;
  const allowed = can(principal, 'files.upload');
  if (!allowed.ok) return refusal(allowed);

  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }

  const needsUsage = !principal.isAdmin && principal.limits?.storageQuotaBytes != null;
  const allowance = uploadAllowance(principal, { usedBytes: needsUsage ? await usedBytesBy(email) : 0 });
  if (allowance === 0) {
    return NextResponse.json({
      error: principal.limits?.maxUploadBytes === 0
        ? 'Your role cannot upload files.'
        : 'You have reached your storage quota. Remove some files, or ask an admin for more room.',
      code: 'quota',
    }, { status: 413 });
  }
  const maximumSizeInBytes = allowance == null ? BLOB_MAX_BYTES : Math.min(BLOB_MAX_BYTES, allowance);

  try {
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        // Allowlist of brand-asset types. Deliberately EXCLUDES image/svg+xml and
        // text/html — both can carry inline script and would be a stored-XSS
        // vector if a recipient opens the file directly.
        allowedContentTypes: [
          'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif',
          'video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v', 'video/ogg',
          'audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/flac',
          'application/pdf', 'text/plain', 'text/csv',
          'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'application/zip',
        ],
        maximumSizeInBytes,
        addRandomSuffix: true,
        validUntil: Date.now() + 30 * 60 * 1000,
      }),
      onUploadCompleted: async () => {},
    });
    return NextResponse.json(json);
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Upload setup failed.' }, { status: 400 });
  }
}
