import { NextResponse } from 'next/server';
import { handleUpload } from '@vercel/blob/client';
import { auth } from '@/auth';

export const runtime = 'nodejs';

/**
 * POST /api/files/upload — Vercel Blob client-upload token for the library
 * (default backend). Broad content types, large size cap. Used when storage
 * mode is 'blob'; the S3 path uses /api/files/presign instead.
 */
export async function POST(req) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }

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
        maximumSizeInBytes: 1024 * 1024 * 1024, // 1 GB
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
