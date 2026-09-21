import { NextResponse } from 'next/server';
import { listFileChanges, currentChangeCursor } from '@/lib/db';
import { resolveActor } from '@/lib/desktop-guard';
import { presignFileUrls } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/files/delta?cursor=<n>&limit=<n> — what changed since `cursor`.
 *
 * This is the endpoint a sync client enumerates against: the iOS File
 * Provider's enumerateChanges(from: anchor), and eventually the desktop app.
 * Cursor 0 means "everything", so first sync and incremental catch-up share
 * one code path.
 *
 * Dual-guarded (cookie or bearer) because both the browser and the native
 * clients read it.
 *
 * Deliberately NOT access-filtered per row yet: it currently serves the single
 * owner of a workspace. Before this is exposed to a multi-user deployment it
 * needs the same principal narrowing the listing has — and the tombstone side
 * needs thought, since "this file was deleted" and "you lost access to this
 * file" look identical to a client and must not be conflated.
 */
export async function GET(req) {
  const actor = await resolveActor(req);
  if (actor.error) return actor.error;

  const url = new URL(req.url);

  // `?cursor=now` hands back the current high-water mark without any payload,
  // for a client that wants to start watching from this moment rather than
  // replay history it does not want.
  if (url.searchParams.get('cursor') === 'now') {
    return NextResponse.json({ changed: [], deleted: [], cursor: await currentChangeCursor(), done: true });
  }

  const cursor = Number(url.searchParams.get('cursor')) || 0;
  const limit = Number(url.searchParams.get('limit')) || 500;

  const page = await listFileChanges({ cursor, limit });

  // Presign only what this page carries. A client streaming a first sync of
  // 100k files pages through in chunks rather than signing them all at once.
  const changed = await presignFileUrls(page.changed);

  return NextResponse.json({
    changed,
    deleted: page.deleted,
    cursor: page.cursor,
    done: page.done,
  });
}
