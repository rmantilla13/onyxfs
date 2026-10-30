import { NextResponse } from 'next/server';
import { listTrashForUser, listFilespaces } from '@/lib/db';
import { requirePrincipal, can, refusal } from '@/lib/authz';
import { drivesHolding } from '@/lib/drive-access';
import { TRASH_RETENTION_DAYS } from '@/lib/storage-report';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const DAY = 24 * 60 * 60 * 1000;

/** "<deletedAt>:<id>" ↔ { deletedAt, id } — the keyset cursor for the next page. */
const encode = (c) => (c ? `${c.deletedAt}:${c.id}` : null);
function decode(raw) {
  const m = /^(\d+):(.+)$/.exec(String(raw || ''));
  return m ? { deletedAt: Number(m[1]), id: m[2] } : null;
}

/**
 * GET /api/files/trash?cursor= → { files, cursor, retentionDays }
 *
 * This person's Trash, newest first: the deleted files they could restore —
 * ones they could see, and could have deleted (lib/db.js listTrashForUser,
 * drives included). Each with its drive, who deleted it and when, and when
 * it is purged. No links: a trashed file is not opened, only put back.
 *
 * The `trash` flag is read here: with it off, a delete is final and there is
 * no Trash to list.
 */
export async function GET(req) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const { principal } = g;
  if (principal.flags?.trash === false) return NextResponse.json({ error: 'The trash is turned off.' }, { status: 404 });
  const allowed = can(principal, 'files.delete');
  if (!allowed.ok) return refusal(allowed);
  try {
    const [{ files: rows, cursor }, drives] = await Promise.all([
      listTrashForUser(principal, { before: decode(new URL(req.url).searchParams.get('cursor')), limit: 50 }),
      listFilespaces(),
    ]);
    const files = rows.map((f) => {
      const drive = drivesHolding(f.storageKey, drives)[0] || null;
      return {
        id: f.id,
        name: f.name,
        folder: f.folder,
        kind: f.kind,
        mime: f.mime,
        size: f.size,
        drive: drive ? { id: drive.id, name: drive.name } : null,
        deletedAt: f.deletedAt,
        deletedBy: f.deletedBy,
        purgesAt: f.deletedAt ? f.deletedAt + TRASH_RETENTION_DAYS * DAY : null,
      };
    });
    return NextResponse.json({ files, cursor: encode(cursor), retentionDays: TRASH_RETENTION_DAYS });
  } catch (e) {
    console.warn('[trash] list failed:', e.message);
    return NextResponse.json({ error: 'The trash could not be read. Try again in a moment.' }, { status: 500 });
  }
}
