import { NextResponse } from 'next/server';
import {
  getFilespaceForUser, getFilespaceForWrite,
  createFolder, renameFolder, deleteFolderRows, listFolderSubtreeFiles, folderPathInUse, renameSpreadsGrants,
  canModifyFolder, softDeleteFile, deleteFile, listFolderRowsUnder, listFilespaces, visibleFileIds, canonicalFolder,
} from '@/lib/db';
import { requirePrincipal, can, refusal } from '@/lib/authz';
import {
  getStorageConfig, storageMode, cfgForFilespace, s3CopyObject, s3DeleteObject,
  s3ObjectExists, s3PutFolderMarker, s3ListFolderMarkers,
} from '@/lib/storage';
import {
  cleanFolder, folderPathProblem, isWithin, planRename, planFolderDelete, rebase, mapLimit, settleLimit,
} from '@/lib/folder-ops';
import { listFolderTree, storagePrefixFor } from '@/lib/file-listing';
import { previewKeysOf, dropUnusedPreviews } from '@/lib/preview-gc';
import { moveTrashedObject } from '@/lib/trash-move';
import { afterResponse } from '@/lib/after-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Objects a rename copies in one request. Each is a HEAD, a copy and a delete;
// at this many the request stays well inside maxDuration on a slow bucket.
// Past it the rename is refused up front rather than timing out half-way.
const MAX_RENAME_OBJECTS = 1000;
// Files a delete trashes per request. Unlike a rename, a delete can stop and
// be continued: the client calls again while `more` is true.
const DELETE_BATCH = 400;
// Parallel S3 requests.
const S3_CONCURRENCY = 8;

const forbidden = (msg = 'No access to that folder.') => NextResponse.json({ error: msg }, { status: 403 });
const bad = (msg, status = 400) => NextResponse.json({ error: msg }, { status });

/**
 * Where a folder's files live: a filespace's bucket and prefix, or the base
 * storage config for the unscoped library. `tag` is what folders.filespace
 * holds for this scope — folder names are per scope, so this is also which
 * "Selects" a request means — and `driveRole` the caller's role in the
 * drive, after their platform role's ceiling: a drive's editors and owners
 * restructure its folders (folderRoleFor). Null when the filespace is not
 * the caller's — or, with `write`, when they may open it but not change it
 * (a drive's viewer).
 */
async function scopeFor(principal, filespaceId, { write = false } = {}) {
  const base = await getStorageConfig();
  const s3 = storageMode(base) === 's3';
  if (filespaceId) {
    const fs = write
      ? await getFilespaceForWrite(principal.email, filespaceId, principal)
      : await getFilespaceForUser(principal.email, filespaceId, principal);
    if (!fs) return null;
    const prefix = cleanFolder(fs.prefix);
    return { scoped: true, tag: prefix, prefix, cfg: s3 ? cfgForFilespace(base, fs) : null, s3, driveRole: fs.role };
  }
  // The prefix storage.buildObjectKey writes unscoped uploads under.
  return { scoped: false, tag: '', prefix: cleanFolder(base.prefix || 'files'), cfg: s3 ? base : null, s3, driveRole: null };
}

/** A folder path as `scope` stores it: composed, in the spelling already there (lib/db.js canonicalFolder). */
function canonicalIn(scope, path) {
  return canonicalFolder(path, { tag: scope.tag, prefix: scope.scoped ? scope.prefix : null });
}

/**
 * GET /api/files/folders?filespace= → { folders }
 * GET /api/files/folders?summary=<folder>&filespace= → { files, folders, outside }
 *
 * The sidebar tree on its own. It counts every file in scope and runs to a
 * couple of hundred kilobytes at 100k files, so the library loads it once per
 * filespace and again only after something changes a folder's contents —
 * rather than with every filter change and search keystroke.
 *
 * `summary` is what the delete confirmation states: how many files and
 * folders a delete of that folder would take with it.
 *
 * Every method here takes the browser's session or Onyx for Mac's bearer
 * token (requirePrincipal(req)): a new folder, a rename or move and a delete
 * in Finder are these same calls.
 */
export async function GET(req) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const { principal, email } = g;
  const url = new URL(req.url);
  const filespaceId = url.searchParams.get('filespace');

  const summary = url.searchParams.get('summary');
  if (summary != null) {
    const scope = await scopeFor(principal, filespaceId);
    if (!scope) return forbidden('No access to that filespace.');
    const name = await canonicalIn(scope, summary);
    if (!name) return bad('Folder required.');
    if (!(await canModifyFolder(name, principal, { driveRole: scope.driveRole, tag: scope.tag }))) return forbidden();
    const files = await listFolderSubtreeFiles(name);
    // What a delete would take (planFolderDelete, as DELETE runs it).
    const drivePrefixes = scope.scoped ? [] : (await listFilespaces()).map((f) => f.prefix);
    const plan = planFolderDelete({ name, files, prefix: scope.prefix, scoped: scope.scoped, drivePrefixes });
    const inScope = new Set(plan.work.map((m) => m.id));
    const dirs = new Set();
    for (const f of files) if (inScope.has(f.id) && f.folder !== name) dirs.add(f.folder);
    for (const r of await listFolderRowsUnder(name, { tag: scope.tag })) dirs.add(r);
    return NextResponse.json({ files: inScope.size, folders: dirs.size, outside: plan.outside.length });
  }

  const storagePrefix = await storagePrefixFor(email, filespaceId, principal);
  if (storagePrefix === null) return forbidden('No access to that filespace.');
  const folders = await listFolderTree({ principal, storagePrefix });
  return NextResponse.json({ folders });
}

/**
 * POST /api/files/folders  { name, filespaceId?, ensure? } → { folder }
 *
 * Create a folder path and its ancestors, empty, in this scope: another
 * drive's folder of the same name, or the library's, is another folder. A
 * role that manages folders, and write access to the drive when it is in one
 * — the bar an upload into a new path has, since that creates the same
 * folder implicitly. 201 when made; with `ensure`, 200 when it was already
 * here; 409 otherwise.
 */
export async function POST(req) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const { principal } = g;
  const allowed = can(principal, 'folders.manage');
  if (!allowed.ok) return refusal(allowed);
  let body = {};
  try { body = await req.json(); } catch { return bad('Bad request'); }
  const problem = folderPathProblem(body.name);
  if (problem) return bad(problem);
  const scope = await scopeFor(principal, body.filespaceId, { write: true });
  if (!scope) return forbidden('You can view this drive but not change it.');
  const name = await canonicalIn(scope, body.name);
  let made;
  try {
    made = await createFolder(name, { createdBy: principal.email, filespace: scope.tag });
  } catch (e) {
    return bad(e.message || 'Create failed.', 500);
  }
  if (!made.created) {
    // `ensure`: the uploader making the empty directories of a dropped tree,
    // for which "already there" is success.
    if (made.existed && body.ensure) return NextResponse.json({ folder: { name } });
    return bad(made.existed
      ? `A folder named “${name.slice(name.lastIndexOf('/') + 1)}” already exists here.`
      // Another scope has the name, and the old primary key on folder names
      // alone still stands: only until the schema guard that drops it has
      // run (lib/db.js ensureFoldersTable; in production, the maintenance
      // cron or `npm run doctor`). Say so rather than answer 201 for a
      // folder that would not show up.
      : `A folder at “${name}” already exists in another filespace, and folder names are not yet per-filespace. Choose another name.`, 409);
  }
  // A zero-byte marker so the empty folder also shows on a mounted drive.
  // Best-effort: the catalog row is what the web shows.
  if (scope.s3 && scope.prefix) { try { await s3PutFolderMarker(scope.cfg, name); } catch {} }
  return NextResponse.json({ folder: { name } }, { status: 201 });
}

/**
 * PATCH /api/files/folders  { from, to, filespaceId? }
 *
 * Rename or move a folder subtree. Object keys encode the folder
 * (`<prefix>/<folder>/<name>`, see storage.buildObjectKey), so this moves
 * bytes as well as rows, and it does so without a half-renamed middle:
 *
 *   1. copy every object to its new key; on any failure, delete the copies
 *      and stop — nothing has changed
 *   2. move files, folder rows and grants in one SQL statement; on failure,
 *      delete the copies and stop — nothing has changed
 *   3. delete the originals. A failure here leaves a stray copy at the old
 *      key, which nothing points to; it is counted in `leftovers`.
 *
 * Both ends are authorized: taking the subtree out of `from` and putting it
 * at `to`, or a rename becomes a way into a folder you do not control. Both
 * are this scope's: another drive's folder of either name is not touched,
 * and neither is the library's.
 */
export async function PATCH(req) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const { principal } = g;
  const allowed = can(principal, 'folders.manage');
  if (!allowed.ok) return refusal(allowed);
  let body = {};
  try { body = await req.json(); } catch { return bad('Bad request'); }
  if (!cleanFolder(body.from)) return bad('Choose a folder to rename.');
  const problem = folderPathProblem(body.to);
  if (problem) return bad(problem);

  const scope = await scopeFor(principal, body.filespaceId, { write: true });
  if (!scope) return forbidden('You can view this drive but not change it.');
  // Both ends as this scope spells them (canonicalIn): the folder a Mac
  // names composed is the one stored decomposed, and a new name is composed.
  const from = await canonicalIn(scope, body.from);
  const to = await canonicalIn(scope, body.to);
  if (from === to) return NextResponse.json({ ok: true, from, to, files: 0, folders: 0 });
  if (isWithin(to, from)) return bad('A folder cannot be moved into itself.');
  if (!(await canModifyFolder(from, principal, { driveRole: scope.driveRole, tag: scope.tag }))) return forbidden();
  if (!(await canModifyFolder(to, principal, { driveRole: scope.driveRole, tag: scope.tag }))) return forbidden('No access to the destination folder.');
  const inScope = { tag: scope.tag, prefix: scope.scoped ? scope.prefix : null };
  // Nothing by that name here: a 404, not a 200 that makes an empty `to`.
  if (!(await folderPathInUse(from, inScope))) return bad(`There is no folder “${from}” here.`, 404);
  if (await folderPathInUse(to, inScope)) {
    return bad(`“${to}” already exists. Choose another name, or move the files into it instead.`, 409);
  }

  const files = await listFolderSubtreeFiles(from);
  const plan = planRename({ from, to, prefix: scope.prefix, scoped: scope.scoped, files });
  // Folder grants are keyed by the path alone, so they cannot follow the
  // folder to a name another scope uses without reaching that scope's folder
  // too. Rather than leave behind the access people were given, refuse, and
  // say why (lib/db.js renameFolder has when grants follow at all).
  if (await renameSpreadsGrants(from, to, { tag: scope.tag, outside: plan.outside.length })) {
    return bad(`“${to}” is also a folder in another drive or in the library, and the access given on “${from}” would reach it there as well. Choose another name, or remove that access first.`, 409);
  }
  if (plan.moves.length > MAX_RENAME_OBJECTS) {
    return bad(`This folder holds ${plan.moves.length} stored files; renaming more than ${MAX_RENAME_OBJECTS} at once is not supported yet. Move its subfolders first.`, 413);
  }
  if (plan.moves.length && !scope.s3) return bad('Storage is not configured for S3, so the stored files cannot be moved.', 409);

  // An object already at a destination key would be overwritten by the copy.
  // Nothing in the catalog points there (the path is unused), but a mounted
  // drive or another tool may have put it there.
  const taken = await settleLimit(plan.moves, S3_CONCURRENCY, (m) => s3ObjectExists(scope.cfg, m.toKey));
  const clash = plan.moves.find((m, i) => taken[i].ok && taken[i].value);
  if (clash) return bad(`Something is already stored at ${clash.toKey}. Nothing was renamed.`, 409);

  const copied = [];
  const undo = () => settleLimit(copied, S3_CONCURRENCY, (k) => s3DeleteObject(scope.cfg, k));
  try {
    await mapLimit(plan.moves, S3_CONCURRENCY, async (m) => {
      await s3CopyObject(scope.cfg, m.fromKey, m.toKey);
      copied.push(m.toKey);
    });
  } catch (e) {
    await undo();
    return bad(`Could not copy a stored file (${e.message}). Nothing was renamed.`, 502);
  }

  let result;
  try {
    result = await renameFolder(from, to, {
      tag: scope.tag,
      moves: plan.moves,
      catalog: plan.catalog,
      moveGrants: plan.outside.length === 0,
      createdBy: principal.email,
    });
  } catch (e) {
    await undo();
    // A row landed on: this scope's own, made since the check above, or —
    // while the old primary key on folder names alone stands — another's.
    const clash = /duplicate key|unique/i.test(e.message || '');
    const here = clash && (await folderPathInUse(to, inScope).catch(() => true));
    const clashMsg = !clash ? (e.message || 'Rename failed.')
      : here ? `A folder at “${to}” already exists here.`
      : `A folder at “${to}” already exists in another filespace, and folder names are not yet per-filespace.`;
    return bad(`${clashMsg} Nothing was renamed.`, clash ? 409 : 500);
  }

  const gone = await settleLimit(plan.moves, S3_CONCURRENCY, (m) => s3DeleteObject(scope.cfg, m.fromKey));
  const leftovers = gone.filter((g) => !g.ok).length;
  if (leftovers) console.warn(`[folders rename] ${leftovers} original object(s) under ${from} could not be deleted`);

  // Empty-folder markers follow the tree. Best-effort, like creating them.
  if (scope.s3 && scope.prefix) {
    try {
      const markers = await s3ListFolderMarkers(scope.cfg, { prefix: scope.prefix, under: from, keys: true });
      for (const k of markers) {
        const rel = k.slice(scope.prefix.length + 1).replace(/\/+$/, '');
        try { await s3PutFolderMarker(scope.cfg, rebase(rel, from, to)); await s3DeleteObject(scope.cfg, k); } catch {}
      }
    } catch {}
  }

  return NextResponse.json({ ...result, outside: plan.outside.length, leftovers });
}

/**
 * DELETE /api/files/folders?name=&filespace= → { deleted, failed, outside, more }
 *
 * Delete a folder and everything in it, each file exactly as DELETE
 * /api/files/[id] would: with the `trash` flag on (read here, never from the
 * request), soft-deleted at once and its object moved to `_trash/<id>/<key>`
 * after the answer (lib/trash-move.js); with it off, removed and tombstoned. At most DELETE_BATCH files per call; `more` means
 * call again. The folder rows go once nothing in this scope is left.
 */
export async function DELETE(req) {
  const g = await requirePrincipal(req);
  if (g.error) return g.error;
  const { principal, email } = g;
  // Deleting a folder trashes every file in it: both capabilities.
  for (const cap of ['files.delete', 'folders.manage']) {
    const allowed = can(principal, cap);
    if (!allowed.ok) return refusal(allowed);
  }
  const url = new URL(req.url);
  if (!cleanFolder(url.searchParams.get('name'))) return bad('Folder required.');
  const scope = await scopeFor(principal, url.searchParams.get('filespace'), { write: true });
  if (!scope) return forbidden('You can view this drive but not change it.');
  const name = await canonicalIn(scope, url.searchParams.get('name'));
  if (!(await canModifyFolder(name, principal, { driveRole: scope.driveRole, tag: scope.tag }))) return forbidden();

  // Global, read here and never from the request.
  const flags = principal.flags;
  const files = await listFolderSubtreeFiles(name);
  const drivePrefixes = scope.scoped ? [] : (await listFilespaces()).map((f) => f.prefix);
  const plan = planFolderDelete({ name, files, prefix: scope.prefix, scoped: scope.scoped, drivePrefixes });
  const { work } = plan;
  // Nothing by that name here: say so, rather than answer "deleted 0" to a
  // client that asked for a folder it only thinks is here (a name Finder
  // made up to tell two folders apart, say) and takes that for done.
  if (!work.length && !(await folderPathInUse(name, { tag: scope.tag, prefix: scope.scoped ? scope.prefix : null }))) {
    return bad(`There is no folder “${name}” here.`, 404);
  }
  // Files in it the caller was never shown — a drive member's private file,
  // to another member of the drive — are not theirs to delete unseen. The
  // whole delete is refused, with how many and why, before anything goes.
  if (!principal.isAdmin && work.length) {
    const seen = await visibleFileIds(work.map((w) => w.id), principal);
    const hidden = work.filter((w) => !seen.has(w.id)).length;
    if (hidden) {
      return NextResponse.json({
        error: `“${name}” holds ${hidden} file${hidden === 1 ? '' : 's'} you cannot see, so it was not deleted. Ask whoever shared ${hidden === 1 ? 'it' : 'them'}, or an admin, to remove ${hidden === 1 ? 'it' : 'them'} first.`,
        code: 'hidden_files',
        hidden,
      }, { status: 409 });
    }
  }
  const batch = work.slice(0, DELETE_BATCH);

  // Objects to move to the trash once this has answered.
  const moving = [];
  const results = await settleLimit(batch, S3_CONCURRENCY, async ({ id, key }) => {
    if (flags.trash === false) {
      if (key && scope.s3) await s3DeleteObject(scope.cfg, key);
      await deleteFile(id);
      return;
    }
    // Trashed at once, as DELETE /api/files/[id] does it: the objects follow
    // after the answer (lib/trash-move.js), rather than a copy of every
    // video in the folder keeping it waiting.
    await softDeleteFile(id, { trashKey: null, deletedBy: email });
    if (key && scope.s3) moving.push(id);
  });
  if (moving.length) {
    afterResponse(`trash ${moving.length} under ${name}`,
      () => settleLimit(moving, S3_CONCURRENCY, (id) => moveTrashedObject(id, { cfg: scope.cfg })));
  }
  const failed = results.filter((r) => !r.ok);
  const deleted = results.length - failed.length;
  const more = work.length > batch.length;
  // With the trash off the rows are gone, and their previews go with them
  // once no other row points at them. (Trashed rows keep theirs for a
  // restore; the purge takes them later.)
  if (flags.trash === false) {
    const gone = new Set(batch.filter((_, i) => results[i]?.ok).map((w) => w.id));
    await dropUnusedPreviews(previewKeysOf(files.filter((f) => gone.has(f.id))));
  }

  if (!more && !failed.length) {
    await deleteFolderRows(name, { tag: scope.tag });
    if (scope.s3 && scope.prefix) {
      try {
        const markers = await s3ListFolderMarkers(scope.cfg, { prefix: scope.prefix, under: name, keys: true });
        await settleLimit(markers, S3_CONCURRENCY, (k) => s3DeleteObject(scope.cfg, k));
      } catch {}
    }
  }
  if (failed.length) console.warn(`[folders delete] ${failed.length} file(s) under ${name} could not be removed: ${failed[0].error?.message}`);
  return NextResponse.json({
    deleted,
    failed: failed.length,
    error: failed[0]?.error?.message || null,
    outside: plan.outside.length,
    more,
    trashed: flags.trash !== false,
  });
}
