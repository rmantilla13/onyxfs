import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getTrashedFiles, restoreFile, storageKeyInUse } from '@/lib/db';
import { getStorageConfig, storageMode, s3MoveObject, s3ObjectExists, s3UniqueKey } from '@/lib/storage';
import { settleLimit } from '@/lib/folder-ops';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX = 200;

/**
 * POST { ids: [...] } → { restored, failed }
 *
 * Put trashed files back. On S3 the object moves from its trash key back to
 * the key it had — or, when a newer file has taken that name in the
 * meantime, to the next free one ("a (2).jpg"), so a restore never
 * overwrites anything. Then restoreFile clears the trash flags and advances
 * the sequence, which is how synced devices learn it is back.
 */
export async function POST(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const ids = Array.isArray(body?.ids) ? [...new Set(body.ids.map(String).filter(Boolean))] : [];
  if (!ids.length) return NextResponse.json({ error: 'ids must be a non-empty list.' }, { status: 400 });
  if (ids.length > MAX) return NextResponse.json({ error: `Restore at most ${MAX} files at once.` }, { status: 400 });

  const rows = await getTrashedFiles(ids);
  const cfg = await getStorageConfig();
  const s3 = storageMode(cfg) === 's3';
  const results = await settleLimit(rows, 8, async (f) => {
    let storageKey = null;
    if (f.trashKey && f.storage === 's3') {
      if (!s3) throw new Error('Storage is not configured for S3, so the stored file cannot be moved back.');
      let target = f.storageKey;
      const taken = await storageKeyInUse(target, { exceptId: f.id }) || await s3ObjectExists(cfg, target).catch(() => false);
      if (taken) target = await s3UniqueKey(cfg, target);
      await s3MoveObject(cfg, f.trashKey, target);
      storageKey = target;
    }
    const restored = await restoreFile(f.id, { storageKey });
    return { id: f.id, name: f.name, movedTo: storageKey !== f.storageKey ? storageKey : null, restored: !!restored };
  });

  const restored = results.filter((r) => r.ok).map((r) => r.value);
  const failed = results.map((r, i) => (r.ok ? null : { id: rows[i].id, error: r.error?.message || 'Restore failed.' })).filter(Boolean);
  const missing = ids.filter((id) => !rows.some((f) => f.id === id));
  if (restored.length) {
    await audit(guard.email, 'trash.restore', { type: 'files', id: 'bulk', label: `${restored.length} file${restored.length === 1 ? '' : 's'}` }, {
      files: restored.map((r) => ({ id: r.id, name: r.name, movedTo: r.movedTo })),
    });
  }
  return NextResponse.json({ restored, failed, notInTrash: missing });
}
