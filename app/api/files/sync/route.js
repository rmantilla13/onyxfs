import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getStorageConfig, storageMode, s3ListObjects, s3ListFolderMarkers, fileKind, presignFileUrls, cfgForFilespace, isThumbnailKey, isSystemKey } from '@/lib/storage';
import { listFiles, createFile, createFolder, deleteFile, getFilespaceForUser } from '@/lib/db';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/files/sync — reconcile the bucket into the library catalog so files
 * added via a mounted drive / Finder show up as first-class library files.
 * Body: { filespaceId? } — when given, scans that filespace's bucket prefix.
 */
export async function POST(req) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  let cfg = await getStorageConfig();
  if (storageMode(cfg) !== 's3') {
    return NextResponse.json({ error: 'Bucket sync needs a custom S3 bucket (Admin → Storage).', code: 'no_bucket' }, { status: 400 });
  }

  // Optional filespace scope: sync only that filespace's prefix.
  let body = {};
  try { body = await req.json(); } catch {}
  if (body.filespaceId) {
    const fs = await getFilespaceForUser(session.user.email, body.filespaceId);
    if (fs) cfg = cfgForFilespace(cfg, fs);
  }

  const SCAN_MAX = 5000;
  try {
    const objects = await s3ListObjects(cfg, { max: SCAN_MAX });
    const { files: existing } = await listFiles({});
    const known = new Set(existing.map((f) => f.storageKey).filter(Boolean));
    // Don't ingest generated thumbnails as files: those referenced as a file's
    // thumbnail, plus anything under `_thumbs/`.
    const thumbKeys = new Set(existing.map((f) => f.thumbnailKey).filter(Boolean));
    const prefix = (cfg.prefix || '').replace(/^\/+|\/+$/g, '');

    let added = 0;
    const created = [];
    for (const o of objects) {
      if (known.has(o.key)) continue;
      if (isThumbnailKey(o.key) || thumbKeys.has(o.key) || isSystemKey(o.key)) continue; // skip thumbnails + OS junk
      // Derive name + folder from the key, relative to the configured prefix.
      let rel = o.key;
      if (prefix && rel.startsWith(prefix + '/')) rel = rel.slice(prefix.length + 1);
      const parts = rel.split('/');
      const name = parts.pop() || o.key;
      const folder = parts.join('/');
      const file = await createFile({
        name, folder, url: o.url, mime: '', size: o.size, kind: fileKind('', name),
        storage: 's3', storageKey: o.key, createdBy: session.user.email,
        // Preserve the object's real date (S3 LastModified) instead of "now".
        createdAt: o.lastModified || undefined, updatedAt: o.lastModified || undefined,
      });
      created.push(file); added += 1;
    }

    // Surface EMPTY folders (bare `dir/` markers, e.g. created in Finder) in the
    // catalog so they show in the tree and can be managed/deleted from Space.
    try {
      const markers = await s3ListFolderMarkers(cfg);
      for (const folderPath of markers) {
        if (!folderPath) continue;
        await createFolder(folderPath, { createdBy: session.user.email, filespace: prefix });
      }
    } catch (e) { console.warn('[sync] folder markers:', e.message); }

    // Deletion sync: catalog files whose S3 object is gone (e.g. deleted in
    // Finder) → remove them so they stop showing on the web. Only when the
    // listing is complete (not truncated) — never purge on a partial scan.
    const removed = [];
    if (objects.length < SCAN_MAX) {
      const seen = new Set(objects.map((o) => o.key));
      const cutoff = Date.now() - 60_000; // skip very recent rows (in-flight uploads)
      for (const f of existing) {
        if (f.storage !== 's3' || !f.storageKey) continue;
        if (prefix && !f.storageKey.startsWith(prefix + '/')) continue; // only this filespace
        if (seen.has(f.storageKey)) continue;
        if ((f.createdAt || 0) > cutoff) continue;
        try { await deleteFile(f.id); removed.push(f.id); } catch {}
      }
    }

    return NextResponse.json({ added, removed, scanned: objects.length, files: await presignFileUrls(created) });
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Sync failed.' }, { status: 500 });
  }
}
