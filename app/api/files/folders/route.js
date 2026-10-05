import { NextResponse } from 'next/server';
import {
  getFilespaceForUser, getFilespaceForWrite,
  createFolder, renameFolder, deleteFolderRows, listFolderSubtreeFiles, folderPathInUse, renameSpreadsGrants,
  canModifyFolder, softDeleteFile, deleteFile, listFolderRowsUnder, listFilespaces, visibleFileIds, canonicalFolder,
  storageKeysInUse, noteFolderMoveCopies, claimFolderMoveCopies, folderMoveCopiesAt, forgetFolderMoveCopies,
  renameFolderStars, deleteFolderStars,
} from '@/lib/db';
import { requirePrincipal, can, refusal } from '@/lib/authz';
import {
  getStorageConfig, storageMode, cfgForFilespace, s3CopyObject, s3DeleteObject,
  s3HeadObject, s3PutFolderMarker, s3ListFolderMarkers,
} from '@/lib/storage';
import {
  cleanFolder, folderPathProblem, isWithin, planRename, planFolderDelete, rebase, mapLimit, settleLimit, folderMoveBudgetMs,
  folderRenameLimit, isCopyOf,
} from '@/lib/folder-ops';
import { listFolderTree, storagePrefixFor } from '@/lib/file-listing';
import { markFolderLinks } from '@/lib/share-guard';
import { previewKeysOf, dropUnusedPreviews } from '@/lib/preview-gc';
import { moveTrashedObject } from '@/lib/trash-move';
import { afterResponse } from '@/lib/after-response';
import { ndjsonResponse } from '@/lib/ndjson';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;


// Files a delete trashes per request. Unlike a rename, a delete can stop and
// be continued: the client calls again while `more` is true.
const DELETE_BATCH = 400;
// Parallel S3 requests.
const S3_CONCURRENCY = 8;
// Parallel HEADs and DELETEs of a rename: small requests with nothing to
// carry, so more at a time — a big folder's check and tidy take a quarter
// as long as at S3_CONCURRENCY.
const S3_LOOKUPS = 32;

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
/** A refusal when no drive is named and there is no All files; else null. */
function needsDrive(principal, filespaceId) {
  if (filespaceId) return null;
  const lib = can(principal, 'library.use');
  return lib.ok ? null : refusal(lib);
}

async function scopeFor(principal, filespaceId, { write = false } = {}) {
  // No drive named is All files, and with none there is no scope at all.
  if (!filespaceId && !can(principal, 'library.use').ok) return null;
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
 * rather than with every filter change and search keystroke. A folder whose
 * links the caller may manage carries `share: true` (markFolderLinks).
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
    const noDrive = needsDrive(principal, filespaceId);
    if (noDrive) return noDrive;
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

  const noDrive = needsDrive(principal, filespaceId);
  if (noDrive) return noDrive;
  const storagePrefix = await storagePrefixFor(email, filespaceId, principal);
  if (storagePrefix === null) return forbidden('No access to that filespace.');
  const folders = await listFolderTree({ principal, storagePrefix });
  // `share: true` on the folders whose links are theirs to manage, for the
  // iPhone's Share Link… (lib/share-guard.js markFolderLinks).
  return NextResponse.json({ folders: await markFolderLinks(folders, principal, { filespaceId: filespaceId || null }) });
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
  const noDrive = needsDrive(principal, body.filespaceId);
  if (noDrive) return noDrive;
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
 * PATCH /api/files/folders  { from, to, filespaceId?, resumable?, replace?, progress? }
 *
 * Rename or move a folder subtree. Object keys encode the folder
 * (`<prefix>/<folder>/<name>`, see storage.buildObjectKey), so this moves
 * bytes as well as rows, and it does so without a half-renamed middle:
 *
 *   1. copy every object to its new key, noting each copy first. A copy an
 *      earlier call made and noted is kept, not made again. Anything else
 *      already at a new key is refused — 409 `occupied`, unless `replace`
 *      (the web asks first) — and one a file in the library holds, always.
 *      On any failure, delete the copies and stop — nothing has changed.
 *      With `resumable` (the web), a big folder is copied over several
 *      calls: 202 { more, copied, total } until every copy is in place, and
 *      a failure keeps the copies for the next call
 *   2. move files, folder rows and grants in one SQL statement; on failure,
 *      delete the copies and stop — nothing has changed
 *   3. delete the originals. A failure here leaves a stray copy at the old
 *      key, which nothing points to; it is counted in `leftovers`.
 *
 * With `progress` (the web), once the request has passed its checks the
 * response is a stream of NDJSON (lib/ndjson.js): { phase, done, total } as
 * each step goes — check, copy, catalog, tidy — then { status, body }, the
 * answer the plain response would have been.
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

  const noDrive = needsDrive(principal, body.filespaceId);
  if (noDrive) return noDrive;
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
  // Refused up front past what can be done: the web (resumable) goes on
  // over as many calls as the copying takes; a caller that does it in one
  // call is held to what one call can copy (lib/folder-ops.js).
  const limit = folderRenameLimit({ resumable: body.resumable === true });
  if (plan.moves.length > limit) {
    const n = plan.moves.length.toLocaleString('en-US');
    return bad(body.resumable === true
      ? `This folder holds ${n} stored files; renaming or moving more than ${limit.toLocaleString('en-US')} at once is not supported yet. Move its subfolders first.`
      : `This folder holds ${n} stored files, more than can be renamed from here at once. Rename it on the web, which moves it in steps.`, 413);
  }
  if (plan.moves.length && !scope.s3) return bad('Storage is not configured for S3, so the stored files cannot be moved.', 409);

  // The rest is the work, as one function of what to tell the caller as it
  // goes: with `progress` (the web's move and rename), each step is streamed
  // as a line — checking what is already at the new keys, copying, updating
  // the library, removing the originals — and the answer comes last
  // (lib/ndjson.js); without, the answer is the response, as it always was.
  const answer = (status, out) => ({ status, body: out });
  const carryOn = async (report) => {
    const resumable = body.resumable === true;
    const budget = folderMoveBudgetMs();
    const began = Date.now();

    // What is already at the new keys. Nothing in the catalog lists the new
    // path, so an object there is one of these:
    //   - a file the catalog keeps all the same (one in the trash that never
    //     moved aside): never touched, so refused;
    //   - a copy an earlier call of this rename made and noted
    //     (folder_move_copies) — cut off by the time limit, a call never gets
    //     to undo its copies: kept, not made again, while it is still a copy
    //     of the original; made again (over itself) otherwise;
    //   - something else — a move that didn't finish before copies were
    //     noted, a mounted drive, another tool: refused, unless the caller
    //     says to `replace` it (the web asks first).
    // A new key noted as the copy of a file from outside this drive is one
    // the files outside every drive are being moved to (POST
    // /api/admin/library/move), whether or not its copy has landed yet: that
    // move points a row at it once it has, so it is never copied over. The
    // rename waits for the move instead — asked here, and again when this
    // rename notes its own copies, which never take over such a key
    // (claimFolderMoveCopies), so a move that notes one in between is not
    // missed.
    const movingIn = () => answer(409, {
      error: `Files from outside every drive are being moved into “${to}”, or a move of them stopped part-way. Once that move has finished — run it again from Admin → Usage if it stopped — try again. Nothing was renamed.`,
    });
    if (scope.scoped && plan.moves.length) {
      const noted = await folderMoveCopiesAt(plan.moves.map((m) => m.toKey));
      const theirs = [...noted.values()].some((fromKey) => !String(fromKey).startsWith(`${scope.prefix}/`));
      if (theirs) return movingIn();
    }

    let looked = 0;
    report('check', 0, plan.moves.length);
    const heads = await settleLimit(plan.moves, S3_LOOKUPS, async (m) => {
      try { return await s3HeadObject(scope.cfg, m.toKey); } finally { report('check', ++looked, plan.moves.length); }
    });
    const there = new Map(plan.moves.map((m, i) => [m.toKey, heads[i].ok ? heads[i].value : null]));
    const found = plan.moves.filter((m) => there.get(m.toKey));
    const todo = plan.moves.filter((m) => !there.get(m.toKey));
    const reused = [];
    if (found.length) {
      const keys = found.map((m) => m.toKey);
      const [held, noted] = await Promise.all([storageKeysInUse(keys), folderMoveCopiesAt(keys)]);
      const kept = found.find((m) => held.has(m.toKey));
      if (kept) return answer(409, { error: `A file the library keeps is already stored at ${kept.toKey}. Nothing was renamed.` });
      const strangers = found.filter((m) => !noted.has(m.toKey));
      if (strangers.length && body.replace !== true) {
        const n = strangers.length;
        return answer(409, {
          error: `${n.toLocaleString('en-US')} file${n === 1 ? ' is' : 's are'} already stored at “${to}” but not in the library (${strangers[0].toKey}${n > 1 ? ', …' : ''}), perhaps left by a move that didn't finish. Nothing was renamed.`,
          code: 'occupied', occupied: n, from, to,
        });
      }
      const mine = found.filter((m) => noted.get(m.toKey) === m.fromKey);
      const origs = await settleLimit(mine, S3_LOOKUPS, (m) => s3HeadObject(scope.cfg, m.fromKey));
      const still = new Set(mine.filter((m, i) => isCopyOf(there.get(m.toKey), origs[i].ok ? origs[i].value : null)).map((m) => m.toKey));
      for (const m of found) (still.has(m.toKey) ? reused.push(m.toKey) : todo.push(m));
    }

    // The copies, each noted first. A caller that can come back (`resumable`)
    // is answered 202 `more` once the budget has gone, and the next call finds
    // these copies above; one that can't (Onyx for Mac, which takes any 2xx as
    // done) gets the whole rename in one call, as before. Every call starts at
    // least one copy, so each gets somewhere.
    let started = 0;
    const deferred = [];
    const copied = [];
    const sizes = new Map(files.map((f) => [f.id, f.size]));
    const allKeys = plan.moves.map((m) => m.toKey);
    // Undo takes every copy at the new keys, this call's and an earlier one's:
    // each is a copy of an original still in place. But never one a row has
    // come to point at — this rename, running twice at once, done by the other
    // call — and none when that can't be checked: kept, and noted, they are
    // used next time.
    const undo = async () => {
      const keys = [...reused, ...copied];
      let held;
      try { held = await storageKeysInUse(keys); } catch { return; }
      const drop = keys.filter((k) => !held.has(k));
      const gone = await settleLimit(drop, S3_LOOKUPS, (k) => s3DeleteObject(scope.cfg, k));
      const stuck = new Set(drop.filter((k, i) => !gone[i].ok || gone[i].value === false));
      await forgetFolderMoveCopies(allKeys.filter((k) => !stuck.has(k))).catch(() => {});
    };
    if (todo.length && scope.scoped) {
      if ((await claimFolderMoveCopies(todo, { within: `${scope.prefix}/` })).length) return movingIn();
    } else if (todo.length) {
      await noteFolderMoveCopies(todo);
    }
    const inPlace = () => reused.length + copied.length;
    report('copy', inPlace(), plan.moves.length);
    // A long video past 5 GiB is copied in parts (lib/storage.js copyObjectWithin).
    try {
      await mapLimit(todo, S3_CONCURRENCY, async (m) => {
        if (resumable && started > 0 && Date.now() - began >= budget) { deferred.push(m); return; }
        started++;
        await s3CopyObject(scope.cfg, m.fromKey, m.toKey, { size: sizes.get(m.id) });
        copied.push(m.toKey);
        report('copy', inPlace(), plan.moves.length);
      });
    } catch (e) {
      // A resumable rename keeps its copies for the next call to carry on
      // from. One that isn't leaves nothing behind.
      if (!resumable) await undo();
      return answer(502, { error: `Could not copy a stored file (${e.message}). Nothing was renamed.` });
    }
    if (deferred.length) {
      return answer(202, {
        more: true, from, to,
        copied: plan.moves.length - deferred.length,
        total: plan.moves.length,
      });
    }

    report('catalog');
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
      return answer(clash ? 409 : 500, { error: `${clashMsg} Nothing was renamed.` });
    }

    // Renamed: from here on the answer is a 200 whatever the tidying does.
    await forgetFolderMoveCopies(allKeys).catch(() => {});
    let tidied = 0;
    report('tidy', 0, plan.moves.length);
    const gone = await settleLimit(plan.moves, S3_LOOKUPS, async (m) => {
      try { return await s3DeleteObject(scope.cfg, m.fromKey); } finally { report('tidy', ++tidied, plan.moves.length); }
    });
    const leftovers = gone.filter((g) => !g.ok).length;
    if (leftovers) console.warn(`[folders rename] ${leftovers} original object(s) under ${from} could not be deleted`);

    // Stars on it follow, everyone's. Best-effort: a star left behind points
    // at an empty folder, not at anything it should not.
    await renameFolderStars(scope.scoped ? String(body.filespaceId) : '', from, to)
      .catch((e) => console.warn('[folders rename] stars did not follow:', e.message));

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

    return answer(200, { ...result, outside: plan.outside.length, leftovers });
  };
  if (body.progress === true) return ndjsonResponse(carryOn);
  const out = await carryOn(() => {});
  return NextResponse.json(out.body, { status: out.status });
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
  const noDrive = needsDrive(principal, url.searchParams.get('filespace'));
  if (noDrive) return noDrive;
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
    await deleteFolderStars(scope.scoped ? String(url.searchParams.get('filespace')) : '', name)
      .catch((e) => console.warn('[folders delete] stars stayed:', e.message));
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
