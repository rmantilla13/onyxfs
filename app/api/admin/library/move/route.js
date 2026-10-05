import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { readGlobalFlags } from '@/lib/authz';
import {
  libraryUsage, countLooseFiles, listLooseFiles, moveLooseFile, listFilespaces, getFilespace, canonicalFolder,
  storageKeyInUse, storageKeysInUse, uploadKeyHeld, issueUploadKey, claimUploadKey,
  noteFolderMoveCopies, forgetFolderMoveCopies, folderMoveCopiesInto,
  moveFoldersIntoDrive, listCollections, moveCollection,
} from '@/lib/db';
import {
  getStorageConfig, storageMode, cfgForFilespace, buildObjectKey, s3UniqueKey, s3CopyObject, s3DeleteObject,
  s3HeadObject, publicUrlForKey, s3PutFolderMarker, s3ListFolderMarkers,
} from '@/lib/storage';
import { cleanFolder, folderPathProblem, baseName, mapLimit, settleLimit, folderMoveBudgetMs, isCopyOf } from '@/lib/folder-ops';
import {
  moveRoute, landingFolder, landedName, isLooseKey, noteState, collectionMoves,
} from '@/lib/library-move';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Files read per query; a call goes through as many of these as its time allows.
const BATCH = 200;
// Parallel copies, as a folder rename makes them.
const S3_CONCURRENCY = 8;
// Parallel HEADs and DELETEs: small requests, more at a time.
const S3_LOOKUPS = 32;

const bad = (error, status = 400) => NextResponse.json({ error }, { status });
const dirOf = (key) => key.slice(0, key.lastIndexOf('/') + 1);

/**
 * Where the move can take files, or why it cannot: the flags (read here,
 * never from the request) and the bucket. null when it can.
 */
function refusalFor(flags, base) {
  if (!flags) return { status: 503, error: 'Couldn’t read the settings. Try again.' };
  if (!flags.filespaces) return { status: 409, error: 'Drives are turned off, so there is no drive to move files into.' };
  if (storageMode(base) !== 's3') return { status: 409, error: 'Storage is not configured for S3, so the stored files cannot be moved.' };
  return null;
}

/**
 * GET /api/admin/library/move → { files, bytes, movable: { files, bytes }, drives: [{ id, name, problem }], problem }
 *
 * What is kept outside every drive — every live file under no drive's
 * prefix, as Admin → Usage counts it (libraryUsage) — and how much of it the
 * move takes (`movable`): the files in the bucket. The rest are files kept
 * in Vercel Blob from before a bucket was set up, or previews and the OS's
 * junk, which no listing shows; they stay where they are. With every drive
 * and why one could not take them (lib/library-move.js moveRoute) — never
 * its keys — and `problem` when none could.
 */
export async function GET() {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  const [flags, base, drives] = await Promise.all([readGlobalFlags(), getStorageConfig(), listFilespaces()]);
  const drivePrefixes = drives.map((d) => d.prefix);
  const [outside, movable] = await Promise.all([libraryUsage({ drivePrefixes }), countLooseFiles({ drivePrefixes })]);
  return NextResponse.json({
    ...outside,
    movable,
    drives: drives
      .map((d) => ({ id: d.id, name: d.name, problem: moveRoute(base, d).problem || null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    problem: refusalFor(flags, base)?.error || null,
  });
}

/**
 * POST /api/admin/library/move  { driveId, folder?, after? }
 *   → 202 { more: true, moved, failed, skipped, left, after } — call again with `after`
 *   → 200 { moved, failed, skipped, left, folders, links, stars, collections, leftovers }
 *
 * Moves every file outside every drive into the drive `driveId`, at `folder`
 * in it (its top without one), each where an upload into that folder would
 * put it: the drive's prefix, the folder, the file's own folder and its name
 * (storage.buildObjectKey), the next free name when that one is taken
 * (s3UniqueKey) — so nothing in the drive is written over. A file in
 * "Shoot/Day 1" lands in "<folder>/Shoot/Day 1".
 *
 * Like a folder rename (PATCH /api/files/folders), for each file: the copy
 * is noted (folder_move_copies), the object copied, the row pointed at the
 * copy — its seq moved, so every device sees the file leave the library for
 * the drive — and only then the original deleted, once nothing holds it.
 * Each call works through as many files as its time allows
 * (folderMoveBudgetMs) and answers 202 with `after`, where the next carries
 * on; it can be stopped anywhere. A call cut off between the copy and the
 * row leaves a noted copy the next one uses, and one cut off after the row
 * a noted original the next one deletes, so no file is lost, and none ends
 * up in the drive twice. Once no file is left, 200, and the library's
 * folders follow the files:
 *
 *   folder rows, with their tags and metadata, folder links and everyone's
 *   stars — into the drive at the same place (lib/db.js moveFoldersIntoDrive)
 *   collections — the drive's now, renamed where it has one of that name
 *   empty folders' markers in the bucket, as a rename moves them
 *
 * Folder grants stay where they are. They are keyed by the path alone and
 * open nothing inside a drive, where its members decide (lib/drive-access.js),
 * so carried along they would grant nothing, and only cover the same path in
 * every other scope. Someone who saw these files through a grant on a folder
 * now needs to be a member of the drive. Links to files are by id and keep
 * working; previews (_thumbs/) are the app's own and stay where they are.
 * Files in the trash stay too: restored, one comes back where it was, and is
 * counted here again.
 *
 * A drive in a bucket of its own reached by the same keys is copied into
 * bucket to bucket; one with keys of its own elsewhere is refused
 * (lib/library-move.js moveRoute). Admins only, as everything here acts on
 * files whoever may open them.
 */
export async function POST(req) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  let body = {};
  try { body = await req.json(); } catch { return bad('Bad request'); }
  const driveId = typeof body.driveId === 'string' ? body.driveId.trim() : '';
  if (!driveId) return bad('Choose a drive to move the files into.');
  const asked = typeof body.folder === 'string' ? body.folder : '';
  if (cleanFolder(asked)) {
    const problem = folderPathProblem(asked);
    if (problem) return bad(problem);
  }
  const after = typeof body.after === 'string' ? body.after : '';

  const [flags, base] = await Promise.all([readGlobalFlags(), getStorageConfig()]);
  const refused = refusalFor(flags, base);
  if (refused) return bad(refused.error, refused.status);
  // Read fresh, both: a drive made a moment ago is one to move into, and a
  // file under it is not one to move.
  const [drives, drive] = await Promise.all([listFilespaces(), getFilespace(driveId)]);
  if (!drive) return bad('There is no such drive.', 404);
  const way = moveRoute(base, drive);
  if (way.problem) return bad(way.problem, 409);
  const prefix = cleanFolder(drive.prefix);
  // The Storage keys reach the drive's prefix in the Storage bucket whatever
  // keys it mounts with; a bucket of its own is reached as its uploads are.
  const dest = way.mode === 'within' ? { ...base, prefix } : cfgForFilespace(base, drive);
  const fromBucket = way.mode === 'across' ? base.bucket : null;
  const under = await canonicalFolder(asked, { tag: prefix, prefix });
  const drivePrefixes = drives.map((d) => d.prefix);

  const began = Date.now();
  const budget = folderMoveBudgetMs();
  const count = { moved: 0, failed: 0, skipped: 0, leftovers: 0 };
  let firstError = null;

  // What earlier calls left part-way, from their notes: originals to delete,
  // copies to carry on from, and copies nothing will use (noteState).
  const reuse = new Map();
  {
    const notes = (await folderMoveCopiesInto(prefix)).filter((n) => isLooseKey(n.fromKey, drivePrefixes));
    const holding = notes.length ? await storageKeysInUse(notes.flatMap((n) => [n.toKey, n.fromKey])) : new Set();
    const tidied = await settleLimit(notes, S3_LOOKUPS, async (n) => {
      const state = noteState(n, holding);
      if (state === 'reuse') { reuse.set(n.fromKey, n.toKey); return; }
      if (state === 'tidy') await s3DeleteObject(base, n.fromKey);
      if (state === 'orphan') await s3DeleteObject(dest, n.toKey);
      await forgetFolderMoveCopies([n.toKey]);
    });
    count.leftovers += tidied.filter((t) => !t.ok).length;
  }

  // Each file's folder in the drive, as this scope spells it (canonicalFolder).
  const landings = new Map();
  const landing = (folder) => {
    if (!landings.has(folder)) landings.set(folder, canonicalFolder(landingFolder(under, folder), { tag: prefix, prefix }));
    return landings.get(folder);
  };
  // A key is free when nothing is stored there (s3UniqueKey), no upload in
  // flight was handed it, no row holds it — and no other file of this call
  // has taken it, which the bucket cannot know until that copy lands. One
  // that cannot be asked about fails the file, which the next run retries.
  const claimed = new Set();
  const held = async (k) => {
    if (claimed.has(k)) return true;
    if (await uploadKeyHeld(k)) return true;
    if (await storageKeyInUse(k)) return true;
    if (claimed.has(k)) return true;
    claimed.add(k);
    return false;
  };
  // A copy of ours nothing points at: gone, and so is its note.
  const dropCopy = async (key) => {
    try {
      if (!(await storageKeyInUse(key))) await s3DeleteObject(dest, key);
      await forgetFolderMoveCopies([key]);
    } catch {}
  };
  // Where an earlier call's copy of this file can be carried on from:
  // { key, copied }, or null to start afresh. Only in the folder this run is
  // moving it to; made again over itself when the original has been written
  // since (isCopyOf). A copy noted and never made keeps its key — the call
  // had it spoken for, and that may not have lapsed — unless someone else
  // has come to want it since.
  const carryOn = async (noted, wanted, fromKey) => {
    if (dirOf(noted) !== dirOf(wanted)) { await dropCopy(noted); return null; }
    const [copy, orig] = await Promise.all([s3HeadObject(dest, noted), s3HeadObject(base, fromKey)]);
    if (copy) {
      claimed.add(noted);
      return { key: noted, copied: isCopyOf(copy, orig) };
    }
    if (claimed.has(noted) || await storageKeyInUse(noted) || await uploadKeyHeld(noted, { by: gate.email })) {
      await forgetFolderMoveCopies([noted]);
      return null;
    }
    claimed.add(noted);
    return { key: noted, copied: false };
  };

  const moveOne = async (f) => {
    const fromKey = f.storageKey;
    const folder = await landing(f.folder);
    const wanted = buildObjectKey(dest, f.name, folder);
    let to = reuse.has(fromKey) ? await carryOn(reuse.get(fromKey), wanted, fromKey) : null;
    if (!to) to = { key: await s3UniqueKey(dest, wanted, { held }), copied: false };
    // Spoken for, as an upload's key is (uploadKeyHeld), until the row holds
    // it: an upload into the drive meanwhile takes the next name, and never
    // lands on the copy and becomes this file's bytes.
    await issueUploadKey(to.key, gate.email, { bucket: dest.bucket });
    let moved;
    try {
      await noteFolderMoveCopies([{ fromKey, toKey: to.key }]);
      // A long video past 5 GiB is copied in parts (lib/storage.js copyObjectWithin).
      if (!to.copied) await s3CopyObject(dest, fromKey, to.key, { size: f.size, fromBucket });
      const name = landedName(f.name, baseName(wanted), baseName(to.key));
      moved = await moveLooseFile(f.id, { fromKey, toKey: to.key, folder, name, url: publicUrlForKey(dest, to.key) });
    } finally {
      await claimUploadKey(to.key, gate.email).catch(() => {});
    }
    if (!moved) {
      // Trashed, moved or given new contents meanwhile: it stays as it is.
      await dropCopy(to.key);
      return 'skipped';
    }
    // The original goes once nothing holds it — another row may share it —
    // and the note with it. A failure leaves both, for the next call.
    try {
      if (!(await storageKeyInUse(fromKey))) await s3DeleteObject(base, fromKey);
      await forgetFolderMoveCopies([to.key]);
    } catch {
      count.leftovers += 1;
    }
    return 'moved';
  };

  // Batches until the time has gone. Every call starts at least one file,
  // so each gets somewhere; one not started is a file the next call
  // begins with (`after` stops short of it).
  let cursor = after;
  let more = false;
  let started = 0;
  for (;;) {
    const rows = await listLooseFiles({ drivePrefixes, after: cursor, limit: BATCH });
    if (!rows.length) break;
    const results = await mapLimit(rows, S3_CONCURRENCY, async (f) => {
      if (started > 0 && Date.now() - began >= budget) return null;
      started++;
      try { return await moveOne(f); } catch (e) { return e; }
    });
    for (let i = 0; i < rows.length; i++) {
      const r = results[i];
      // Not started: these are the last of the batch, as files are started in order.
      if (r === null) { more = true; break; }
      cursor = rows[i].id;
      if (r === 'moved') count.moved += 1;
      else if (r === 'skipped') count.skipped += 1;
      else {
        count.failed += 1;
        firstError ||= r?.message || 'Move failed.';
      }
    }
    if (more || rows.length < BATCH) break;
    if (Date.now() - began >= budget) { more = true; break; }
  }
  if (count.failed) console.warn(`[library move] ${count.failed} file(s) could not be moved into ${prefix}: ${firstError}`);

  const subject = { type: 'drive', id: drive.id, label: drive.name };
  const left = (await countLooseFiles({ drivePrefixes })).files;
  if (more) {
    if (count.moved) await audit(gate.email, 'library.move', subject, { into: under || null, moved: count.moved, failed: count.failed });
    return NextResponse.json({ more: true, ...count, left, after: cursor, error: firstError }, { status: 202 });
  }

  // Every file has been looked at: the library's folders follow them.
  let carried;
  try {
    carried = await moveFoldersIntoDrive({ tag: prefix, driveId: drive.id, under, createdBy: gate.email });
    const moves = collectionMoves(await listCollections(), { driveId: drive.id });
    for (const c of moves) await moveCollection(c.id, { driveId: drive.id, name: c.name });
    carried.collections = moves.length;
  } catch (e) {
    return NextResponse.json({
      ...count, left,
      error: `The files are in “${drive.name}”, but the library’s folders could not follow them (${e.message}). Run the move again to finish.`,
    }, { status: 500 });
  }
  // Empty folders' markers follow, as a rename's do. Best-effort, like
  // making them: the folder rows are what the web shows.
  try {
    const basePrefix = cleanFolder(base.prefix || 'files');
    const markers = (await s3ListFolderMarkers(base, { prefix: basePrefix, keys: true }))
      .filter((k) => isLooseKey(k, drivePrefixes) && k.startsWith(`${basePrefix}/`));
    await settleLimit(markers, S3_CONCURRENCY, async (k) => {
      const rel = cleanFolder(k.slice(basePrefix.length + 1));
      if (!rel) return;
      await s3PutFolderMarker(dest, landingFolder(under, rel));
      await s3DeleteObject(base, k);
    });
  } catch {}

  await audit(gate.email, 'library.move', subject, {
    into: under || null, moved: count.moved, failed: count.failed, done: true,
    folders: carried.folders, links: carried.links, collections: carried.collections,
  });
  return NextResponse.json({ ...count, left, ...carried, error: firstError });
}
