import { NextResponse } from 'next/server';
import {
  listFileChanges, currentChangeCursor, getFilespaceForUser, listFilespaces, listSyncFolders,
} from '@/lib/db';
import { resolveActor } from '@/lib/desktop-guard';
import { presignFileUrls } from '@/lib/storage';
import { drivePatterns } from '@/lib/drive-access';
import { accessFingerprint, syncScope } from '@/lib/sync-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/files/delta?cursor=<n>&limit=<n>&drive=<id|library>&folders=1
 *
 * What changed since `cursor`: the endpoint a sync client enumerates against —
 * the File Provider behind Onyx in Finder and in Files.app. Cursor 0 means
 * "everything", so first sync and incremental catch-up share one code path.
 * Dual-guarded (cookie or bearer), because the browser and the native clients
 * both read it.
 *
 * AUTHORIZE → FILTER → PRESIGN, as everywhere else: the rows come out of the
 * same access rule as the library listing (buildDeltaQuery), only what the
 * caller may see is presigned, and anything else that changed comes back as a
 * bare id in `deleted` — gone, as far as this caller is concerned.
 *
 *   drive=<filespaceId>  that drive only; you must be able to open it
 *   drive=library        files in no drive
 *   (none)               everything you may see
 *
 * `scope` fingerprints the access the page was computed under. When it
 * differs from the last one a client saw, the client re-syncs from cursor 0
 * (lib/sync-scope.js says why). `folders=1` adds the scope's folders, whole,
 * so empty ones appear too.
 */
export async function GET(req) {
  const actor = await resolveActor(req);
  if (actor.error) return actor.error;

  const url = new URL(req.url);
  // The same principal the web and the desktop's own routes use: drive roles
  // already capped by the platform role (lib/authz.js).
  const { principal } = actor;
  const allDrives = await listFilespaces();

  const driveParam = (url.searchParams.get('drive') || '').trim();
  let drive = null;
  if (driveParam && driveParam !== 'library') {
    drive = await getFilespaceForUser(actor.email, driveParam, principal);
    if (!drive) return NextResponse.json({ error: 'No access to this drive' }, { status: 404 });
  }
  const scope = syncScope({ drive, library: driveParam === 'library', allDrives });
  if (!scope) return NextResponse.json({ error: 'This drive has no folder in the bucket to sync' }, { status: 400 });

  const tag = accessFingerprint(principal, drivePatterns(allDrives));

  // `?cursor=now` hands back the current high-water mark without any payload,
  // for a client that wants to start watching from this moment rather than
  // replay history it does not want.
  if (url.searchParams.get('cursor') === 'now') {
    return NextResponse.json({ changed: [], deleted: [], cursor: await currentChangeCursor(), done: true, scope: tag });
  }

  let page;
  try {
    page = await listFileChanges({
      cursor: Number(url.searchParams.get('cursor')) || 0,
      limit: Number(url.searchParams.get('limit')) || 500,
      principal,
      scope,
    });
  } catch {
    // A retryable failure, so a device tries again rather than believing it
    // has everything.
    return NextResponse.json({ error: 'Changes could not be read right now.' }, { status: 503, headers: { 'retry-after': '30' } });
  }

  // Presign only what this page carries. A client streaming a first sync of
  // 100k files pages through in chunks rather than signing them all at once.
  const changed = await presignFileUrls(page.changed);

  const body = { changed, deleted: page.deleted, cursor: page.cursor, done: page.done, scope: tag };
  if (url.searchParams.get('folders') === '1') {
    const storagePrefix = drive ? String(drive.prefix || '').replace(/^\/+|\/+$/g, '') : undefined;
    body.folders = driveParam ? await listSyncFolders(principal, { storagePrefix }) : [];
  }
  return NextResponse.json(body);
}
