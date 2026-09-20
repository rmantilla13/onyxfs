import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import {
  buildPrincipal, listFilesForUser, listExpiredTrash,
  restoreFile, deleteFile, getFileById, canModifyFile,
} from '@/lib/db';
import { getStorageConfig, storageMode, s3PresignGet, s3DeleteObject, s3MoveObject } from '@/lib/storage';

export const runtime = 'nodejs';

const RETENTION_DAYS = 60;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Permanently remove a trashed file's bytes + record. */
async function purge(file, cfg) {
  if (file?.storage === 's3' && file.trashKey && cfg && storageMode(cfg) === 's3') {
    try { await s3DeleteObject(cfg, file.trashKey); } catch {}
    try { if (file.thumbnailKey) await s3DeleteObject(cfg, file.thumbnailKey); } catch {}
  }
  await deleteFile(file.id);
}

/** GET /api/files/trash — list trashed files (auto-purging any past 60 days first). */
export async function GET() {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const now = Date.now();
  let cfg = null;
  try { cfg = await getStorageConfig(); } catch {}

  // Sweep: anything older than the retention window is gone for good.
  try {
    const expired = await listExpiredTrash(now - RETENTION_MS);
    for (const f of expired) await purge(f, cfg);
  } catch (e) { console.warn('[trash] purge sweep failed:', e.message); }

  const principal = await buildPrincipal(session.user.email);
  let files = [];
  try { const r = await listFilesForUser({ trashed: true }, principal); files = r.files || []; } catch {}

  // Presign from the trash location (the object was moved there on delete).
  if (cfg && storageMode(cfg) === 's3') {
    files = await Promise.all(files.map(async (f) => {
      const out = { ...f };
      if (f.storage === 's3' && f.trashKey) { try { out.url = await s3PresignGet(cfg, f.trashKey); } catch {} }
      if (f.thumbnailKey) { try { out.thumbnailUrl = await s3PresignGet(cfg, f.thumbnailKey); } catch {} }
      return out;
    }));
  }
  files = files.map((f) => ({ ...f, daysLeft: Math.max(0, Math.ceil((f.deletedAt + RETENTION_MS - now) / 86400000)) }));
  return NextResponse.json({ files, retentionDays: RETENTION_DAYS });
}

/** POST /api/files/trash  Body: { id, action: 'restore' | 'purge' } */
export async function POST(req) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const { id, action } = body;
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const file = await getFileById(id);
  if (!file) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Restore and purge are writes — purge is the permanent one. The listing
  // above is already access-filtered, but a POST carries an id the caller
  // chose, so it has to be checked on its own.
  const actor = await buildPrincipal(session.user.email);
  if (!(await canModifyFile(file, actor))) {
    return NextResponse.json({ error: 'No access' }, { status: 403 });
  }
  let cfg = null;
  try { cfg = await getStorageConfig(); } catch {}

  try {
    if (action === 'restore') {
      // Move the object back to its original key so it reappears in the mount.
      if (file.storage === 's3' && file.trashKey && file.storageKey && cfg && storageMode(cfg) === 's3') {
        await s3MoveObject(cfg, file.trashKey, file.storageKey);
      }
      const f = await restoreFile(id);
      return NextResponse.json({ ok: true, file: f });
    }
    if (action === 'purge') {
      await purge(file, cfg);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Trash action failed.' }, { status: 500 });
  }
}
