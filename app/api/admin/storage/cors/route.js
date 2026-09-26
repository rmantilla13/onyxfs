import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getStorageConfig, storageMode, s3PutBucketCors } from '@/lib/storage';
import { corsRule } from '@/lib/storage-cors';
import { deploymentOrigins } from '../origins';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST — one-click bucket CORS repair for browser presigned-PUT uploads
 * (the "Failed to fetch" fix). Allows this deployment's own origins — the
 * one this request came in on, NEXT_PUBLIC_APP_URL and the brand's — plus
 * its Vercel previews when it runs on Vercel (corsOrigins). When the key may
 * not change CORS, the answer carries the exact rule to paste by hand.
 */
export async function POST(req) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  const cfg = await getStorageConfig({ fresh: true });
  if (storageMode(cfg) !== 's3') {
    return NextResponse.json({ error: 'Storage is not set up with an S3 bucket yet, so there is no bucket to set CORS on.' }, { status: 400 });
  }

  const origins = await deploymentOrigins(req);

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
      origins,
      manualRule: corsRule(origins),
    }, { status: denied ? 403 : 500 });
  }
}
