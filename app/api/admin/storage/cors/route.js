import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getStorageConfig, storageMode, s3PutBucketCors } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST — one-click bucket CORS repair for browser presigned-PUT uploads
 * (the "Failed to fetch" fix). Allows this deployment's own origin plus
 * localhost + Vercel previews so dev/preview uploads work too.
 */
export async function POST(req) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  const cfg = await getStorageConfig({ fresh: true });
  if (storageMode(cfg) !== 's3') {
    return NextResponse.json({ error: 'Storage isn’t configured for a custom S3 bucket.' }, { status: 400 });
  }

  // The deployment's own origin first (works for any white-label domain),
  // then the canonical prod domain, previews, and local dev.
  let reqOrigin = '';
  try { reqOrigin = new URL(req.url).origin; } catch {}
  const origins = [...new Set([
    reqOrigin,
    'https://onyxfs.io',
    'https://*.vercel.app',
    'http://localhost:3000',
  ].filter((o) => o && o.startsWith('http')))];

  try {
    const result = await s3PutBucketCors(cfg, { origins });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const denied = /AccessDenied|not authorized/i.test(`${e?.name || ''} ${e?.message || ''}`);
    return NextResponse.json({
      error: denied
        ? 'This key isn’t allowed to change bucket CORS (s3:PutBucketCors). Ask whoever manages the bucket to add a CORS rule allowing PUT from this site.'
        : (e.message || 'Failed to set bucket CORS.'),
      // Hand back the exact rule so it can be pasted into the S3 console →
      // bucket → Permissions → CORS if the key can't do it itself.
      manualRule: [{
        AllowedOrigins: origins,
        AllowedMethods: ['PUT', 'GET', 'HEAD', 'POST'],
        AllowedHeaders: ['*'],
        ExposeHeaders: ['ETag'],
        MaxAgeSeconds: 3000,
      }],
    }, { status: denied ? 403 : 500 });
  }
}
