import { NextResponse } from 'next/server';
import { listTrashForUser } from '@/lib/db';
import { requirePrincipal, can, refusal } from '@/lib/authz';
import { getStorageConfig } from '@/lib/storage';
import { restoreTrashedFiles } from '@/lib/trash-restore';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX = 200;

/**
 * POST { ids: [...] } → { restored, failed, notInTrash }
 *
 * Put files back from this person's Trash — the Trash page's Restore, and
 * the Undo a delete offers. Only rows their own Trash lists
 * (listTrashForUser: seen, and could have been deleted by them); any other id
 * is answered as not in the trash, which says nothing about whether it is.
 * Each goes back as lib/trash-restore.js puts it: at its own key, or beside
 * a newer file that took its name, never over it.
 *
 * The `trash` flag is read here, as the list reads it.
 */
export async function POST(req) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const { principal, email } = g;
  if (principal.flags?.trash === false) return NextResponse.json({ error: 'The trash is turned off.' }, { status: 404 });
  const allowed = can(principal, 'files.delete');
  if (!allowed.ok) return refusal(allowed);
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const ids = Array.isArray(body?.ids) ? [...new Set(body.ids.map(String).filter(Boolean))] : [];
  if (!ids.length) return NextResponse.json({ error: 'ids must be a non-empty list.' }, { status: 400 });
  if (ids.length > MAX) return NextResponse.json({ error: `Restore at most ${MAX} files at once.` }, { status: 400 });

  try {
    const { files: rows } = await listTrashForUser(principal, { ids, limit: ids.length });
    const { restored, failed } = await restoreTrashedFiles(rows, { cfg: await getStorageConfig() });
    const back = restored.filter((r) => r.restored);
    if (back.length) {
      await audit(email, 'trash.restore', { type: 'files', id: 'bulk', label: `${back.length} file${back.length === 1 ? '' : 's'}` }, {
        files: back.map((r) => ({ id: r.id, name: r.name, movedTo: r.movedTo })),
      });
    }
    return NextResponse.json({ restored, failed, notInTrash: ids.filter((id) => !rows.some((f) => f.id === id)) });
  } catch (e) {
    console.warn('[trash] restore failed:', e.message);
    return NextResponse.json({ error: 'Those files could not be restored. Try again in a moment.' }, { status: 500 });
  }
}
