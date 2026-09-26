import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { listTrashedFiles, listFilespaces } from '@/lib/db';
import { drivesHolding } from '@/lib/drive-access';
import { TRASH_RETENTION_DAYS } from '@/lib/storage-report';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const DAY = 24 * 60 * 60 * 1000;

/** "<deletedAt>:<id>" ↔ { deletedAt, id } — the keyset cursor for the next page. */
const encode = (f) => (f ? `${f.deletedAt}:${f.id}` : null);
function decode(raw) {
  const m = /^(\d+):(.+)$/.exec(String(raw || ''));
  return m ? { deletedAt: Number(m[1]), id: m[2] } : null;
}

/**
 * GET /api/admin/trash?cursor= → { files, cursor, retentionDays }
 *
 * Soft-deleted files, newest first: name, drive, who deleted it and when,
 * when it will be purged, and its size. Admins only — the trash holds every
 * drive's deleted files, and restoring is an admin's call.
 */
export async function GET(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  const limit = 100;
  const [rows, drives] = await Promise.all([
    listTrashedFiles({ before: decode(new URL(req.url).searchParams.get('cursor')), limit }),
    listFilespaces(),
  ]);
  const files = rows.map((f) => {
    const drive = drivesHolding(f.storageKey, drives)[0] || null;
    return {
      id: f.id,
      name: f.name,
      folder: f.folder,
      kind: f.kind,
      size: f.size,
      drive: drive ? { id: drive.id, name: drive.name } : null,
      deletedAt: f.deletedAt,
      deletedBy: f.deletedBy,
      purgesAt: f.deletedAt ? f.deletedAt + TRASH_RETENTION_DAYS * DAY : null,
      createdBy: f.createdBy,
    };
  });
  return NextResponse.json({
    files,
    cursor: rows.length === limit ? encode(rows[rows.length - 1]) : null,
    retentionDays: TRASH_RETENTION_DAYS,
  });
}
