import { NextResponse } from 'next/server';
import { listExpiredTrash, deleteFile, listAllFiles, getFileMetadataSchema, listStaleUploads, deleteUpload } from '@/lib/db';
import { getStorageConfig, s3DeleteObject, s3AbortMultipartUpload } from '@/lib/storage';
import { normalizeSchema, expiryState } from '@/lib/dam';
import { notifyExpiringRights } from '@/lib/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TRASH_RETENTION_DAYS = 30;
// How long an untouched upload stays resumable before it is treated as
// abandoned. Generous on purpose — coming back to a half-finished 40 GB
// transfer the next day should still work.
const UPLOAD_STALE_DAYS = 7;

/**
 * Daily maintenance. Two jobs:
 *   1. Purge trashed files past the retention window — the row AND the object,
 *      in that order, so a failed object delete leaves a row to retry from
 *      rather than an orphaned object nobody can find.
 *   2. Warn about usage rights that have lapsed or are about to.
 *
 * Bearer-authed with CRON_SECRET; the middleware excludes /api/cron.
 */
export async function GET(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const out = { purged: 0, purgeErrors: 0, expired: 0, soon: 0, uploadsAborted: 0 };

  try {
    const cutoff = Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const cfg = await getStorageConfig();
    for (const row of await listExpiredTrash(cutoff)) {
      try {
        if (row.storageKey) await s3DeleteObject(cfg, row.storageKey);
        await deleteFile(row.id);
        out.purged++;
      } catch (e) {
        out.purgeErrors++;
        console.warn('[cron] purge failed for', row.id, e.message);
      }
    }
  } catch (e) {
    console.warn('[cron] trash purge failed:', e.message);
  }

  // Abandoned multipart uploads. Their parts are stored and billed
  // indefinitely and do NOT appear in the bucket's object listing, so without
  // this they accumulate invisibly. A bucket lifecycle rule for incomplete
  // multipart uploads is the belt-and-braces backstop.
  try {
    const cfg = await getStorageConfig();
    const cutoff = Date.now() - UPLOAD_STALE_DAYS * 24 * 60 * 60 * 1000;
    for (const u of await listStaleUploads(cutoff)) {
      try {
        await s3AbortMultipartUpload(cfg, { key: u.storageKey, uploadId: u.uploadId });
        await deleteUpload(u.id);
        out.uploadsAborted++;
      } catch (e) {
        console.warn('[cron] abort upload failed for', u.id, e.message);
      }
    }
  } catch (e) {
    console.warn('[cron] stale upload sweep failed:', e.message);
  }

  try {
    const schema = normalizeSchema(await getFileMetadataSchema());
    const files = await listAllFiles();
    const expired = [];
    const soon = [];
    for (const f of files) {
      const state = expiryState(f, schema);
      if (state === 'expired') expired.push(f);
      else if (state === 'soon') soon.push(f);
    }
    out.expired = expired.length;
    out.soon = soon.length;
    if (expired.length || soon.length) await notifyExpiringRights({ expired, soon });
  } catch (e) {
    console.warn('[cron] expiry scan failed:', e.message);
  }

  return NextResponse.json({ ok: true, ...out });
}
