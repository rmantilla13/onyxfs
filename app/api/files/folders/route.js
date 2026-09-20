import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createFolder, deleteFolder, renameFolder, grantFolderAccess, revokeFolderAccess, buildPrincipal, getFilespaceForUser, listAllFiles, softDeleteFile, setFileStorageKey } from '@/lib/db';
import { getStorageConfig, storageMode, s3PutFolderMarker, cfgForFilespace, s3MoveObject, s3DeleteObject, folderToKeyPath, s3ListFolderMarkers } from '@/lib/storage';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** POST /api/files/folders  Body: { name, filespaceId? } — create a folder path (+ ancestors). */
export async function POST(req) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  if (!body.name || !String(body.name).trim()) return NextResponse.json({ error: 'Folder name required.' }, { status: 400 });
  try {
    // Resolve the filespace (if any) so the folder is tagged + its marker lands
    // under that filespace's prefix (and thus shows on the matching mounted drive).
    let scoped = null, fsPrefix = '';
    if (body.filespaceId) {
      const fs = await getFilespaceForUser(session.user.email, body.filespaceId);
      if (fs) { fsPrefix = String(fs.prefix || '').replace(/^\/+|\/+$/g, ''); scoped = fs; }
    }
    const folder = await createFolder(body.name, { createdBy: session.user.email, filespace: fsPrefix });
    // On S3, drop a zero-byte marker so the (possibly empty) folder shows up in
    // a mounted drive / Finder. Best-effort — never block folder creation on it.
    try {
      const cfg = await getStorageConfig();
      if (storageMode(cfg) === 's3') await s3PutFolderMarker(scoped ? cfgForFilespace(cfg, scoped) : cfg, body.name);
    } catch { /* marker is non-essential */ }
    return NextResponse.json({ folder });
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Create failed.' }, { status: 500 });
  }
}

/**
 * PATCH — rename/move a folder subtree {from, to}, OR manage folder access
 * {folder, grant|revoke, subjectType, subject, role}.
 */
export async function PATCH(req) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  try {
    if (body.from != null && body.to != null) {
      const r = await renameFolder(body.from, body.to);
      // Re-key the underlying S3 objects so the move/rename also moves the files
      // in the bucket (and thus on a mounted drive) — not just the catalog.
      try {
        const fs = body.filespaceId ? await getFilespaceForUser(session.user.email, body.filespaceId) : null;
        const fsPrefix = fs ? String(fs.prefix || '').replace(/^\/+|\/+$/g, '') : undefined;
        let cfg = await getStorageConfig();
        // Only re-key with a specific filespace active — its prefix tells us where
        // the objects live. In the cross-prefix "All files" view, skip the physical
        // move (catalog rename only) to avoid mis-keying files from other prefixes.
        if (storageMode(cfg) === 's3' && fs) {
          cfg = cfgForFilespace(cfg, fs);
          const prefix = (cfg.prefix || '').replace(/^\/+|\/+$/g, '');
          const files = await listAllFiles({ folderPrefix: body.to, storagePrefix: fsPrefix });
          for (const f of files) {
            if (f.storage !== 's3' || !f.storageKey) continue;
            const base = f.storageKey.slice(f.storageKey.lastIndexOf('/') + 1);
            const fp = folderToKeyPath(f.folder);
            const newKey = [prefix, fp, base].filter(Boolean).join('/');
            if (newKey === f.storageKey) continue;
            try { await s3MoveObject(cfg, f.storageKey, newKey); await setFileStorageKey(f.id, newKey); } catch {}
          }
          // Update folder markers (empty folders) for the renamed node.
          try { await s3DeleteObject(cfg, `${[prefix, folderToKeyPath(body.from)].filter(Boolean).join('/')}/`); } catch {}
          try { await s3PutFolderMarker(cfg, body.to); } catch {}
        }
      } catch (e) { console.warn('[folders rename re-key] failed:', e.message); }
      return NextResponse.json(r);
    }
    if (body.folder != null && body.subject) {
      if (body.revoke) { await revokeFolderAccess({ folder: body.folder, subjectType: body.subjectType, subject: body.subject }); }
      else { await grantFolderAccess({ folder: body.folder, subjectType: body.subjectType, subject: body.subject, role: body.role, grantedBy: session.user.email }); }
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: 'Nothing to do' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Update failed.' }, { status: 500 });
  }
}

/** DELETE /api/files/folders?name=…&cascade=1 — remove a folder (+ subtree if cascade). */
export async function DELETE(req) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const url = new URL(req.url);
  const name = String(url.searchParams.get('name') || '').replace(/^\/+|\/+$/g, '');
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
  const cascade = url.searchParams.get('cascade') === '1';
  const filespaceId = url.searchParams.get('filespace');
  try {
    if (cascade) {
      // Move the folder's files to Trash (S3 object out of the prefix + soft-delete)
      // so the folder doesn't re-derive from leftover rows OR get re-synced from
      // leftover bucket objects. Then drop the folder's marker + tree rows.
      const fs = filespaceId ? await getFilespaceForUser(session.user.email, filespaceId) : null;
      const prefix = fs ? String(fs.prefix || '').replace(/^\/+|\/+$/g, '') : undefined;
      let cfg = null; let isS3 = false;
      try { cfg = await getStorageConfig(); isS3 = storageMode(cfg) === 's3'; } catch {}
      const files = await listAllFiles({ folderPrefix: name, storagePrefix: prefix });
      for (const f of files) {
        let trashKey = null;
        if (isS3 && f.storage === 's3' && f.storageKey) {
          trashKey = `_trash/${f.id}/${f.storageKey}`;
          try { await s3MoveObject(cfg, f.storageKey, trashKey); } catch { trashKey = null; }
        }
        try { await softDeleteFile(f.id, { trashKey }); } catch {}
      }
      if (isS3) {
        const base = (prefix != null ? prefix : String(cfg.prefix || '').replace(/^\/+|\/+$/g, ''));
        // Delete the folder's own marker + any empty-subfolder markers beneath it.
        try { await s3DeleteObject(cfg, `${base ? base + '/' : ''}${name}/`); } catch {}
        try {
          const markers = await s3ListFolderMarkers(cfg, { prefix: base, under: name, keys: true });
          for (const k of markers) { try { await s3DeleteObject(cfg, k); } catch {} }
        } catch {}
      }
    }
    await deleteFolder(name, { cascade });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Delete failed.' }, { status: 500 });
  }
}
