import { NextResponse } from 'next/server';
import { listExpiredTrash, deleteFile, listAllFiles, getFileMetadataSchema } from '@/lib/db';
import { getStorageConfig, s3DeleteObject } from '@/lib/storage';
import { normalizeSchema, expiryState } from '@/lib/dam';
import { notifyExpiringRights } from '@/lib/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TRASH_RETENTION_DAYS = 30;

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

  const out = { purged: 0, purgeErrors: 0, expired: 0, soon: 0 };

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
