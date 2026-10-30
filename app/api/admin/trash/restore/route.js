import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { getTrashedFiles } from '@/lib/db';
import { getStorageConfig } from '@/lib/storage';
import { restoreTrashedFiles } from '@/lib/trash-restore';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX = 200;

/**
 * POST { ids: [...] } → { restored, failed }
 *
 * Put trashed files back, as lib/trash-restore.js does it: the object moves
 * from its trash key back to the key it had — or, when a newer file has taken
 * that name in the meantime, to the next free one ("a (2).jpg"), so a restore
 * never overwrites anything — and the row advances its sequence, which is how
 * synced devices learn it is back.
 *
 * Any trashed file, in any drive. Everyone else restores from their own
 * Trash (/api/files/trash/restore), held to the rules that decide what they
 * could have deleted. Unlike the rest of /api/admin this also takes Onyx for
 * Mac's bearer token (requireAdmin(req)) — held to the same test, so no one
 * restores from the Mac who could not from the web.
 */
export async function POST(req) {
  const guard = await requireAdmin(req);
  if (guard.error) return guard.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const ids = Array.isArray(body?.ids) ? [...new Set(body.ids.map(String).filter(Boolean))] : [];
  if (!ids.length) return NextResponse.json({ error: 'ids must be a non-empty list.' }, { status: 400 });
  if (ids.length > MAX) return NextResponse.json({ error: `Restore at most ${MAX} files at once.` }, { status: 400 });

  const rows = await getTrashedFiles(ids);
  const { restored, failed } = await restoreTrashedFiles(rows, { cfg: await getStorageConfig() });
  const missing = ids.filter((id) => !rows.some((f) => f.id === id));
  if (restored.length) {
    await audit(guard.email, 'trash.restore', { type: 'files', id: 'bulk', label: `${restored.length} file${restored.length === 1 ? '' : 's'}` }, {
      files: restored.map((r) => ({ id: r.id, name: r.name, movedTo: r.movedTo })),
    });
  }
  return NextResponse.json({ restored, failed, notInTrash: missing });
}
