import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getTrashedFiles } from '@/lib/db';
import { getStorageConfig } from '@/lib/storage';
import { purgeTrashedFile } from '@/lib/maintenance';
import { settleLimit } from '@/lib/folder-ops';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX = 200;

/**
 * POST { ids: [...] } → { purged, failed }
 *
 * Delete trashed files now rather than when the retention window ends: the
 * trashed copy of the object, then the row — exactly what the daily purge
 * does (purgeTrashedFile), so "purge now" cannot delete a different key from
 * "purge later". Only rows already in the trash; a live file id is ignored.
 */
export async function POST(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const ids = Array.isArray(body?.ids) ? [...new Set(body.ids.map(String).filter(Boolean))] : [];
  if (!ids.length) return NextResponse.json({ error: 'ids must be a non-empty list.' }, { status: 400 });
  if (ids.length > MAX) return NextResponse.json({ error: `Purge at most ${MAX} files at once.` }, { status: 400 });

  const rows = await getTrashedFiles(ids);
  const cfg = await getStorageConfig();
  const results = await settleLimit(rows, 8, (f) => purgeTrashedFile(f, cfg));
  const purged = rows.filter((_, i) => results[i].ok).map((f) => ({ id: f.id, name: f.name }));
  const failed = results.map((r, i) => (r.ok ? null : { id: rows[i].id, error: r.error?.message || 'Purge failed.' })).filter(Boolean);
  if (purged.length) {
    await audit(guard.email, 'trash.purge', { type: 'files', id: 'bulk', label: `${purged.length} file${purged.length === 1 ? '' : 's'}` }, { files: purged });
  }
  return NextResponse.json({ purged: purged.length, failed, notInTrash: ids.filter((id) => !rows.some((f) => f.id === id)) });
}
