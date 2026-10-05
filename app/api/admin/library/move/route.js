import { createHash, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { readGlobalFlags } from '@/lib/authz';
import {
  libraryUsage, countLooseFiles, listLooseFiles, moveLooseFile, listFilespaces, listDrivePrefixes, getFilespace,
  canonicalFolder, folderSpellings, folderPathsInUse, storageKeyInUse, storageKeysInUse, uploadKeyHeld,
  issueUploadKey, claimUploadKey, claimFolderMoveCopy, forgetFolderMoveCopies, libraryMoveNotes,
  claimLibraryMove, updateLibraryMove, libraryMoveRun, libraryFolderState, foldersOutsideDrives, moveFoldersIntoDrive,
  listCollections, moveCollection,
} from '@/lib/db';
import {
  getStorageConfig, storageMode, cfgForFilespace, buildObjectKey, s3UniqueKey, s3CopyObject, s3CopyInParts,
  s3DeleteObject, s3HeadObject, s3ObjectExistsStrict, publicUrlForKey, s3PutFolderMarker, s3ListLevel,
  s3AbortMultipartUploadsAt, COPY_OBJECT_MAX,
} from '@/lib/storage';
import { cleanFolder, folderPathProblem, baseName, mapLimit, settleLimit, folderMoveBudgetMs, isCopyOf } from '@/lib/folder-ops';
import {
  MOVE_HOLDER, moveRoute, landingFolder, landingPath, landedName, insideAnother, heldFolders, folderLandings,
  isNameOf, noteState, collectionMoves,
} from '@/lib/library-move';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Files read per query; a call goes through as many of these as its time allows.
const BATCH = 200;
// Parallel copies, as a folder rename makes them.
const S3_CONCURRENCY = 8;
// Parallel HEADs, DELETEs and listings: small requests, more at a time.
const S3_LOOKUPS = 32;
// Notes read per query when settling what earlier calls left.
const NOTES_PAGE = 500;
// The lease a call holds while it runs (lib/db.js claimLibraryMove): past the
// longest a call can live (maxDuration), and renewed every RENEW_MS while it
// does, so a call that runs on (a server with no limit, a copy that takes
// minutes) keeps it, and one that was cut off lets go of it within LEASE_MS.
const LEASE_MS = 90_000;
const RENEW_MS = 15_000;
// A copy past what one CopyObject takes goes in parts (s3CopyInParts), and
// the parts a call has no time for are carried on with by the next. It is
// started only this early in a call, so that most of the call goes on it;
// later, it waits for the next call, which starts with it.
const BIG_START_MS = 2_000;
// How long a run's first call's decision about links is kept for the calls
// after it, while no file has moved; once one has, until the run ends.
const RUN_KEPT_MS = 24 * 60 * 60 * 1000;
// The time the empty folders' markers get in the last call, however little
// of the budget the files left them.
const MARKERS_MIN_MS = 5_000;
// Files with nothing stored to move named in an answer, at most.
const NAMED = 5;

const bad = (error, status = 400, more = {}) => NextResponse.json({ error, ...more }, { status });
const num = (n) => Number(n || 0).toLocaleString('en-US');
const filesN = (n) => `${num(n)} file${n === 1 ? '' : 's'}`;
const BUSY = 'Files are already being moved into a drive, by this page in another tab or by another admin. Try again in a minute.';
// A folder link's token is the secret that opens it, so a run keeps a
// fingerprint of each link it will carry, never the token: the run is kept in
// a settings row, and every instance reads that table into memory whole
// (lib/db.js getSetting).
const linkMark = (token) => createHash('sha256').update(String(token)).digest('hex').slice(0, 32);

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
 * GET /api/admin/library/move
 *   → { files, bytes, movable: { files, bytes }, private: { files, bytes },
 *       drives: [{ id, name, problem, warning }], run, problem }
 *
 * What is kept outside every drive — every live file under no drive's
 * prefix, as Admin → Usage counts it (libraryUsage) — and how much of it the
 * move takes: `movable`, the files in the bucket every member may see, and
 * `private`, those only some may (visibility 'owner' or 'custom'), which it
 * takes only when asked to (POST `private`). The rest are files kept in
 * Vercel Blob from before a bucket was set up, or previews and the OS's
 * junk, which no listing shows; they stay where they are. With every drive,
 * why one could not take them (lib/library-move.js moveRoute) and what to
 * know first (`warning`: a copy between regions) — never its keys; `run`,
 * { driveId, folder }, when a run stopped part-way, which carries on only
 * there; and `problem` when no drive could take them.
 */
export async function GET() {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  const [flags, base, drives, prefixes, run] = await Promise.all([
    readGlobalFlags(), getStorageConfig(), listFilespaces(), listDrivePrefixes(), libraryMoveRun(),
  ]);
  const drivePrefixes = prefixes.map((d) => d.prefix);
  const [outside, movable, restricted] = await Promise.all([
    libraryUsage({ drivePrefixes }),
    countLooseFiles({ drivePrefixes, visibility: 'org' }),
    countLooseFiles({ drivePrefixes, visibility: 'restricted' }),
  ]);
  return NextResponse.json({
    ...outside,
    movable,
    private: restricted,
    drives: drives
      .map((d) => {
        const way = moveRoute(base, d);
        return { id: d.id, name: d.name, problem: way.problem || null, warning: way.warning || null };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    run: run?.pinned && prefixes.some((d) => d.id === run.driveId) ? { driveId: run.driveId, folder: run.under || '' } : null,
    problem: refusalFor(flags, base)?.error || null,
  });
}

/**
 * POST /api/admin/library/move  { driveId, folder?, private?, after? }
 *   → 202 { more: true, moved, failed, missing, missingNames, skipped, blocked, left, after, error }
 *       — call again with `after`
 *   → 200 { moved, failed, missing, missingNames, skipped, blocked, left, stays,
 *           folders, copied, links, linksLeft, stars, collections, markersLeft, leftovers, error }
 *   → 409 { code: 'busy' } while another call is moving files
 *   → 409 { code: 'elsewhere', run: { driveId, folder } } while a run into
 *     another drive or folder is part-way
 *
 * Moves the files outside every drive into the drive `driveId`, at `folder`
 * in it (its top without one), each where an upload into that folder would
 * put it: the drive's prefix, the folder, the file's own folder and its name
 * (storage.buildObjectKey), the next free name when that one is taken
 * (s3UniqueKey) — so nothing in the drive is written over. A file in
 * "Shoot/Day 1" lands in "<folder>/Shoot/Day 1".
 *
 * Which files: those every member may see. A drive's members can read
 * everything under its prefix from a mounted drive, whatever the web shows
 * them, so a private file (visibility 'owner' or 'custom') moved in is one
 * every member who mounts the drive can open. Those move only with
 * `private`, which the admin ticks in the dialog knowing that; otherwise
 * they stay outside (`stays`). In the drive its members decide who sees
 * what: anyone who saw a file without being one — its uploader, someone it
 * was shared with, someone given a folder — needs adding to the drive. A
 * file whose key would land inside another drive nested in this one is not
 * moved (`blocked`): that drive's members never chose it. Another run, into
 * another folder, takes it. A file with nothing stored at its key — its
 * object deleted outside the app, or kept in the bucket of a drive since
 * deleted, whose files fall back outside every drive — has nothing to move
 * (`missing`, the first few by name, `missingNames`), and stays.
 *
 * Like a folder rename (PATCH /api/files/folders), for each file: its new
 * key is held — noted as its copy (folder_move_copies) and held as an
 * upload's is (upload_keys) — before anything is asked about it, then
 * checked, the object copied, the row pointed at the copy — its seq moved,
 * so every device sees the file leave the library for the drive — and only
 * then the original deleted, once nothing holds it. Each call works through
 * as many files as its time allows (folderMoveBudgetMs) and answers 202 with
 * `after`, where the next carries on; it can be stopped anywhere. A call cut
 * off between the copy and the row leaves a noted copy the next one uses,
 * and one cut off after the row a noted original the next one deletes, so no
 * file is lost, and none ends up in the drive twice. A video past 5 GiB is
 * copied in parts over as many calls as that takes (s3CopyInParts).
 *
 * One call at a time, whoever makes it (lib/db.js claimLibraryMove): two at
 * once could each find the same key free for two files, or one tidy away a
 * copy the other is about to point a row at. A second is answered 409, and
 * its run carries on once the first has answered. And one destination per
 * run: once a run has started moving files, the calls after it go to the
 * same drive and folder until it has ended — the library's folders follow
 * the files to where they landed, and files of one run in two places would
 * leave one place without them.
 *
 * Once every file has been looked at, the run ends, and the library's
 * folders follow the files:
 *
 *   folder rows, with their tags and metadata, and everyone's stars — to
 *     the folder their files landed at (lib/db.js moveFoldersIntoDrive). A
 *     folder that still holds a file outside every drive — one left private,
 *     missing, blocked or failed, or kept in Vercel Blob — is copied there
 *     rather than moved, and the library keeps its row, so the files on both
 *     sides keep what they inherit (lib/library-move.js heldFolders). A run
 *     that moves the rest later merges it into the drive's then
 *   folder links — only those whose folder the drive did not have when the
 *     run began. A link is evaluated live over every file under its folder,
 *     so one moved onto a folder the drive already had would open the
 *     drive's own files there to whoever holds it. The others stay with the
 *     library, where they open nothing (`linksLeft`). One that follows is the
 *     drive's now, as far as the drive allows: a link whose maker may not
 *     share from the drive is paused (lib/share-access.js), and it reaches
 *     only the files that moved
 *   collections — the drive's now, renamed where it has one of that name
 *   empty folders' markers in the bucket, as a rename moves them: as many
 *     as the last call has time for (`markersLeft` when not all). A marker
 *     shows an empty folder on a mounted drive; the web lists folder rows
 *
 * Folder grants stay keyed by their path, as everywhere: a grant on
 * "Clients" lets a drive member see private files in the drive's "Clients"
 * too, so moved to its top a grant still reaches them; moved into a folder,
 * the paths change and it no longer does. Links to files are by id and keep
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
  const withPrivate = body.private === true;

  const [flags, base] = await Promise.all([readGlobalFlags(), getStorageConfig()]);
  const refused = refusalFor(flags, base);
  if (refused) return bad(refused.error, refused.status);
  // Read fresh, both, and every drive: a drive made a moment ago is one to
  // move into, and a file under any drive is not one to move.
  const [drives, drive] = await Promise.all([listDrivePrefixes(), getFilespace(driveId)]);
  if (!drive) return bad('There is no such drive.', 404);
  const way = moveRoute(base, drive);
  if (way.problem) return bad(way.problem, 409);
  const prefix = cleanFolder(drive.prefix);
  const under = await canonicalFolder(asked, { tag: prefix, prefix });
  const nested = under ? insideAnother(`${prefix}/${under}/`, { prefix, drives }) : null;
  if (nested) {
    return bad(`“${under}” is inside the drive “${nested.name}”, which has members of its own. Choose that drive, or another folder.`, 409);
  }

  const call = randomUUID();
  const lease = await claimLibraryMove({ call, by: gate.email, ms: LEASE_MS });
  if (!lease) return bad(BUSY, 409, { code: 'busy' });
  // Renewed while the call works; lost only when another call has taken it,
  // after which this one starts nothing more.
  const tenure = { lost: false };
  const beat = setInterval(() => {
    updateLibraryMove(call, { until: Date.now() + LEASE_MS }).then((still) => { if (!still) tenure.lost = true; }).catch(() => {});
  }, RENEW_MS);
  beat.unref?.();
  try {
    return await moveFiles({ gate, base, drive, drives, way, prefix, under, after, withPrivate, call, lease, tenure });
  } finally {
    clearInterval(beat);
    await updateLibraryMove(call, { until: 0 }).catch(() => {});
  }
}

/** One call's work, under the lease: what POST describes. */
async function moveFiles({ gate, base, drive, drives, way, prefix, under, after, withPrivate, call, lease, tenure }) {
  const began = Date.now();
  const budget = folderMoveBudgetMs();
  const outOfTime = () => Date.now() - began >= budget || tenure.lost;
  // The Storage keys reach the drive's prefix in the Storage bucket whatever
  // keys it mounts with; a bucket of its own is reached as its uploads are.
  const dest = way.mode === 'within' ? { ...base, prefix } : cfgForFilespace(base, drive);
  const fromBucket = way.mode === 'across' ? base.bucket : null;
  const drivePrefixes = drives.map((d) => d.prefix);
  const visibility = withPrivate ? null : 'org';
  const count = { moved: 0, failed: 0, missing: 0, skipped: 0, blocked: 0, leftovers: 0 };
  const missingNames = [];
  let failedAt = null;
  let blockedBy = null;

  // The run this call is part of (lib/db.js updateLibraryMove keeps it for
  // the calls after it). Once one of its calls has had files to move, its
  // destination is the run's until it ends: asked for another, a call is
  // refused, naming the run's, unless that drive has gone since.
  let run = lease.run && typeof lease.run === 'object' ? lease.run : null;
  if (run?.pinned && (run.driveId !== drive.id || run.under !== under)) {
    const there = await getFilespace(run.driveId);
    if (there) {
      const where = run.under ? `“${run.under}” in “${there.name}”` : `“${there.name}”`;
      return bad(
        `A move into ${where} stopped part-way. Carry on with it there; once it has finished, the next move can go anywhere.`,
        409, { code: 'elsewhere', run: { driveId: run.driveId, folder: run.under || '' } },
      );
    }
    run = null;
  }
  // What the run decided on its first call: the library's folder links that
  // may follow their folders into the drive — those whose folder the drive
  // did not have yet. Asked once, before any file lands: afterwards every
  // one of them is in use, by the files the run moved there.
  if (!run || run.driveId !== drive.id || run.under !== under || (!run.pinned && !(Date.now() - (run.at || 0) < RUN_KEPT_MS))) {
    const [{ links }, spellings] = await Promise.all([libraryFolderState(), folderSpellings({ tag: prefix, prefix })]);
    const landed = links
      .map((l) => ({ token: l.token, there: landingPath(under, l.folder, spellings) }))
      .filter((l) => l.there && !insideAnother(`${prefix}/${l.there}/`, { prefix, drives }));
    const used = await folderPathsInUse(landed.map((l) => l.there), { tag: prefix, prefix });
    run = { driveId: drive.id, under, at: Date.now(), carry: landed.filter((l) => !used.has(l.there)).map((l) => linkMark(l.token)) };
    await updateLibraryMove(call, { run });
  }

  // A drive's objects, as the move reaches them: this drive's, `dest`; any
  // other's — one an earlier run was moving files into — as moveRoute says,
  // or null for one it never could.
  const reach = new Map([[drive.id, dest]]);
  const reachOf = async (key) => {
    const holder = drives
      .filter((d) => cleanFolder(d.prefix) && key.startsWith(`${cleanFolder(d.prefix)}/`))
      .sort((a, b) => cleanFolder(b.prefix).length - cleanFolder(a.prefix).length)[0];
    if (!holder) return null;
    if (!reach.has(holder.id)) {
      const row = await getFilespace(holder.id);
      const w = row ? moveRoute(base, row) : { problem: true };
      reach.set(holder.id, w.problem ? null : w.mode === 'within' ? { ...base, prefix: cleanFolder(row.prefix) } : cfgForFilespace(base, row));
    }
    const cfg = reach.get(holder.id);
    return cfg ? { driveId: holder.id, cfg } : null;
  };
  // Free to delete: no file holds it and no upload in flight was handed it.
  // The move's own holds (MOVE_HOLDER) are its to give up.
  const free = async (key) => !(await storageKeyInUse(key)) && !(await uploadKeyHeld(key, { by: MOVE_HOLDER }));
  // Whether what is stored at a noted key is a copy the move made, before it
  // is deleted: the same bytes as `of` (a HEAD of what it was copied from, or
  // of the copy the file landed at) when there is one to compare with; else
  // written no later than the call that noted it could have written it. A
  // mounted drive writes straight to the bucket, and a file of that name
  // written since is someone's, never the move's to delete. null for nothing
  // there.
  const ourCopy = async (cfg, key, { of = null, notedAt = 0 } = {}) => {
    const there = await s3HeadObject(cfg, key, { strict: true });
    if (!there) return null;
    if (of) return there.size === of.size && !!there.etag && there.etag === of.etag;
    return there.modified == null || !notedAt || there.modified <= notedAt + LEASE_MS;
  };

  // What earlier calls left part-way, from their notes, into whichever drive:
  // originals to delete, copies to carry on from, and copies nothing will use
  // (noteState) — with any copy in parts still open at one. A copy of a file
  // still at its original, made for another drive or folder than this run's,
  // waits until every file at that original has moved, and goes with the
  // last of them (moveOne): until a row has left the original, a call that
  // made it — one that lost its lease and runs on — could still be about to
  // point the row at it.
  const reuse = new Map();
  for (let at = ''; ;) {
    const notes = await libraryMoveNotes({ drivePrefixes, after: at, limit: NOTES_PAGE });
    if (!notes.length) break;
    at = notes[notes.length - 1].toKey;
    const holding = await storageKeysInUse(notes.flatMap((n) => [n.toKey, n.fromKey]));
    const tidied = await settleLimit(notes, S3_LOOKUPS, async (n) => {
      const into = await reachOf(n.toKey);
      if (!into) return;
      const state = noteState(n, holding);
      if (state === 'reuse') {
        reuse.set(n.fromKey, [...(reuse.get(n.fromKey) || []), { toKey: n.toKey, notedAt: n.notedAt, ...into }]);
        return;
      }
      if (state === 'tidy' && await free(n.fromKey)) await s3DeleteObject(base, n.fromKey);
      if (state === 'orphan' && await free(n.toKey)) {
        const mine = await ourCopy(into.cfg, n.toKey, { of: await s3HeadObject(base, n.fromKey), notedAt: n.notedAt });
        if (mine) await s3DeleteObject(into.cfg, n.toKey);
        if (mine !== false) await s3AbortMultipartUploadsAt(into.cfg, n.toKey);
      }
      await forgetFolderMoveCopies([n.toKey]);
    });
    count.leftovers += tidied.filter((t) => !t.ok).length;
    if (notes.length < NOTES_PAGE) break;
  }

  // Each file's folder in the drive, as this scope spells it (canonicalFolder).
  const landings = new Map();
  const landing = (folder) => {
    if (!landings.has(folder)) landings.set(folder, canonicalFolder(landingFolder(under, folder), { tag: prefix, prefix }));
    return landings.get(folder);
  };
  // A key is held before anything is asked about it — noted as this file's
  // copy (claimFolderMoveCopy, which a key noted for anything else refuses),
  // then held as an upload's is — and only then checked: what checks first
  // and holds after leaves a moment in which another writer finds the same
  // key free. A held key is given back when it is taken after all.
  const claimed = new Set();
  const giveBack = async (k) => {
    await forgetFolderMoveCopies([k]).catch(() => {});
    await claimUploadKey(k, MOVE_HOLDER).catch(() => {});
  };
  const reserve = async (fromKey, k) => {
    if (claimed.has(k)) return false;
    if (!(await claimFolderMoveCopy({ fromKey, toKey: k }))) return false;
    claimed.add(k);
    await issueUploadKey(k, MOVE_HOLDER, { bucket: dest.bucket });
    return true;
  };
  // A free key, held. Free: no upload in flight was handed it, no row holds
  // it, and nothing is stored there — the bucket saying so, not a HEAD that
  // failed (s3ObjectExistsStrict). One that cannot be asked about fails the
  // file, which the next run retries.
  const freshKey = async (fromKey, wanted) => {
    const taken = async (k) => {
      if (!(await reserve(fromKey, k))) return true;
      let busy = true;
      try {
        busy = (await uploadKeyHeld(k, { by: MOVE_HOLDER })) || (await storageKeyInUse(k)) || (await s3ObjectExistsStrict(dest, k));
      } finally {
        if (busy) await giveBack(k);
      }
      return busy;
    };
    // The bucket is asked in `taken`, after the key is held, so not before it.
    return s3UniqueKey(dest, wanted, { held: taken, exists: async () => false });
  };
  // A copy of ours nothing points at: gone, and so is its note.
  const dropCopy = async (cfg, key) => {
    try {
      if (await free(key)) await s3DeleteObject(cfg, key);
      await forgetFolderMoveCopies([key]);
    } catch {}
  };
  // Where an earlier call's copy of this file can be carried on from:
  // { key, copied }, or null to take a fresh key. Held again first, as a
  // fresh key is. Given up when someone else has come to want the key since,
  // or when what is stored there is not a copy of the original (isCopyOf):
  // perhaps a copy of bytes the original has been rewritten from since, but
  // perhaps a mounted drive's file of that name, which is never written over.
  // A key that cannot be asked about keeps its note for the next call.
  const carryOn = async (noted, fromKey) => {
    if (!(await reserve(fromKey, noted))) return null;
    if (!(await uploadKeyHeld(noted, { by: MOVE_HOLDER })) && !(await storageKeyInUse(noted))) {
      const [copy, orig] = await Promise.all([s3HeadObject(dest, noted, { strict: true }), s3HeadObject(base, fromKey)]);
      if (!copy) return { key: noted, copied: false };
      if (isCopyOf(copy, orig)) return { key: noted, copied: true };
    }
    await giveBack(noted);
    return null;
  };

  const moveOne = async (f) => {
    const fromKey = f.storageKey;
    const folder = await landing(f.folder);
    const wanted = buildObjectKey(dest, f.name, folder);
    const inner = insideAnother(wanted, { prefix, drives });
    if (inner) return { blocked: inner };
    const noted = reuse.get(fromKey) || [];
    const mine = noted.find((n) => n.driveId === drive.id && isNameOf(n.toKey, wanted));
    let to = mine ? await carryOn(mine.toKey, fromKey) : null;
    if (!to) to = { key: await freshKey(fromKey, wanted), copied: false };
    // Held until the row holds it (or, for a copy in parts the next call
    // carries on with, until then): an upload into the drive meanwhile — the
    // admin's own too — takes the next name, and never lands on the copy and
    // becomes this file's bytes.
    let release = true;
    let moved;
    try {
      if (!to.copied) {
        try {
          if (Number(f.size) > COPY_OBJECT_MAX) {
            if (!(await s3CopyInParts(dest, fromKey, to.key, { fromBucket, stop: outOfTime }))) {
              release = false;
              return 'partial';
            }
          } else if (!(await s3CopyObject(dest, fromKey, to.key, { size: f.size, fromBucket }))) {
            throw new Error('The copy could not be made.');
          }
        } catch (e) {
          // Nothing stored at the original — the bucket saying so — is
          // nothing to move, whatever the copy failed with.
          if ((await s3ObjectExistsStrict(base, fromKey).catch(() => true)) === false) {
            await s3AbortMultipartUploadsAt(dest, to.key).catch(() => {});
            await dropCopy(dest, to.key);
            return { missing: f.name };
          }
          throw e;
        }
      }
      const name = landedName(f.name, baseName(wanted), baseName(to.key));
      moved = await moveLooseFile(f.id, { fromKey, toKey: to.key, folder, name, url: publicUrlForKey(dest, to.key) });
    } finally {
      if (release) await claimUploadKey(to.key, MOVE_HOLDER).catch(() => {});
    }
    if (!moved) {
      // Trashed, moved or given new contents meanwhile: it stays as it is.
      await dropCopy(dest, to.key);
      return 'skipped';
    }
    // The original goes once nothing holds it — another row may share it —
    // and the note with it. A failure leaves both, for the next call. So do
    // copies an earlier run made of it elsewhere, now nothing can point at
    // them — each only while it is still the file's bytes (ourCopy). While
    // another row is still at the original, they all stay: that row may be
    // carrying on from one of them in this very call, its copy found and
    // its row not yet pointed there, and the last of them to move tidies
    // the rest. Nor is a key this call has held for a file (`claimed`) ever
    // tidied here: only the file it was held for gives it up.
    let shared = true;
    try {
      shared = await storageKeyInUse(fromKey);
      if (!shared) await s3DeleteObject(base, fromKey);
      await forgetFolderMoveCopies([to.key]);
    } catch {
      count.leftovers += 1;
    }
    const others = shared ? [] : noted.filter((n) => n.toKey !== to.key && !claimed.has(n.toKey));
    const landedAs = others.length ? await s3HeadObject(dest, to.key) : null;
    for (const n of others) {
      try {
        if (await ourCopy(n.cfg, n.toKey, { of: landedAs, notedAt: n.notedAt }) !== false) await dropCopy(n.cfg, n.toKey);
        else await forgetFolderMoveCopies([n.toKey]);
      } catch {}
    }
    return 'moved';
  };

  // Batches until the time has gone. Every call starts at least one file,
  // so each gets somewhere; one not started is a file the next call begins
  // with (`after` stops short of it), and so is every file after it — a big
  // copy left for the next call holds back the rest of its batch with it.
  // So does a copy in parts the call stopped part-way: the next call
  // carries on with it first.
  let cursor = after;
  let more = false;
  let started = 0;
  let closed = false;
  for (;;) {
    const rows = await listLooseFiles({ drivePrefixes, after: cursor, limit: BATCH, visibility });
    if (!rows.length) break;
    // From here files of this run may land: it goes on to this drive and
    // folder until it ends.
    if (!run.pinned) {
      run = { ...run, pinned: true };
      await updateLibraryMove(call, { run });
    }
    const results = await mapLimit(rows, S3_CONCURRENCY, async (f) => {
      if (!closed && started > 0) {
        const late = Date.now() - began;
        if (outOfTime() || (Number(f.size) > COPY_OBJECT_MAX && late >= BIG_START_MS)) closed = true;
      }
      if (closed) return null;
      started++;
      try { return await moveOne(f); } catch (e) { return e; }
    });
    let held = false;
    for (let i = 0; i < rows.length; i++) {
      const r = results[i];
      // Not started: these are the last of the batch, as files are started in order.
      if (r === null) { more = true; break; }
      if (r === 'partial') { more = true; held = true; continue; }
      if (!held) cursor = rows[i].id;
      if (r === 'moved') count.moved += 1;
      else if (r === 'skipped') count.skipped += 1;
      else if (r?.missing != null) {
        count.missing += 1;
        if (missingNames.length < NAMED) missingNames.push(r.missing);
      } else if (r?.blocked) {
        count.blocked += 1;
        blockedBy ||= r.blocked.name || 'another drive';
      } else {
        count.failed += 1;
        failedAt ||= { name: rows[i].name, why: r?.message || 'Move failed.' };
      }
    }
    if (more || rows.length < BATCH) break;
    if (outOfTime()) { more = true; break; }
  }
  if (count.failed) console.warn(`[library move] ${count.failed} file(s) could not be moved into ${prefix}: ${failedAt.why}`);
  const error = [
    count.failed
      ? `${filesN(count.failed)} could not be moved${count.failed > 1 ? `, among them “${failedAt.name}”` : `: “${failedAt.name}”`} (${failedAt.why}). Moving again tries ${count.failed === 1 ? 'it' : 'them'} again.`
      : null,
    count.blocked ? `${filesN(count.blocked)} would land inside “${blockedBy}”, a drive with members of its own, so ${count.blocked === 1 ? 'it stays' : 'they stay'} outside: once this move has finished, move ${count.blocked === 1 ? 'it' : 'them'} into another folder.` : null,
  ].filter(Boolean).join(' ') || null;

  const subject = { type: 'drive', id: drive.id, label: drive.name };
  const left = (await countLooseFiles({ drivePrefixes, visibility })).files;
  const into = under || null;
  // `private` on every row: it is the choice that opens files to the drive's members.
  const details = { into, moved: count.moved, failed: count.failed, missing: count.missing, private: withPrivate };
  if (more) {
    if (count.moved) await audit(gate.email, 'library.move', subject, details);
    return NextResponse.json({ more: true, ...count, missingNames, left, after: cursor, error }, { status: 202 });
  }
  const stays = withPrivate ? 0 : (await countLooseFiles({ drivePrefixes, visibility: 'restricted' })).files;

  // Every file has been looked at, and the run ends: the library's folders
  // follow the files, each to where its files landed, spelled as they are
  // (landingPath, from the drive's spellings now they are there), and not
  // into another drive. A folder that still holds a file outside every drive
  // is copied rather than moved (heldFolders), so that file keeps what it
  // inherits.
  let carried;
  try {
    const [spellings, library, outside] = await Promise.all([
      folderSpellings({ tag: prefix, prefix }), libraryFolderState(), foldersOutsideDrives({ drivePrefixes }),
    ]);
    const destOf = (path) => {
      const there = landingPath(under, path, spellings);
      return there && !insideAnother(`${prefix}/${there}/`, { prefix, drives }) ? there : null;
    };
    const carry = new Set(run.carry || []);
    carried = await moveFoldersIntoDrive({
      tag: prefix, driveId: drive.id, under, createdBy: gate.email,
      folders: folderLandings(library.rows, destOf, { held: heldFolders(outside) }),
      links: library.links.filter((l) => carry.has(linkMark(l.token))).map((l) => ({ token: l.token, dest: destOf(l.folder) })),
      stars: library.stars.map((folder) => ({ folder, dest: destOf(folder) })),
    });
    carried.linksLeft = library.links.length - carried.links;
    const moves = collectionMoves(await listCollections(), { driveId: drive.id });
    // Only from All files: one moved meanwhile (from the sidebar) stays put.
    let collectionsMoved = 0;
    for (const c of moves) if (await moveCollection(c.id, { driveId: drive.id, name: c.name, from: '' })) collectionsMoved++;
    carried.collections = collectionsMoved;
    await updateLibraryMove(call, { run: null });
  } catch (e) {
    if (count.moved) await audit(gate.email, 'library.move', subject, { ...details, stays });
    return NextResponse.json({
      ...count, missingNames, left, stays,
      error: `The files are in “${drive.name}”, but the library’s folders could not follow them (${e.message}). Run the move again to finish.`,
    }, { status: 500 });
  }

  // When something moved: a pass that moved nothing and carried nothing has
  // nothing to add.
  if (count.moved || carried.folders || carried.copied || carried.links || carried.stars || carried.collections) {
    await audit(gate.email, 'library.move', subject, {
      ...details, stays, done: true,
      folders: carried.folders, copied: carried.copied, links: carried.links, collections: carried.collections,
    });
  }

  // Empty folders' markers follow, as a rename's do. Best-effort, like
  // making them: the folder rows are what the web shows. Walked a level at a
  // time with a delimiter, passing over every drive's subtree, so what it
  // reads is the library's folders and not every object under the base
  // prefix — for as long as this call has, and no longer: the run has ended,
  // and a walk that came back for the rest would start again from the top.
  const basePrefix = `${cleanFolder(base.prefix || 'files')}/`;
  const driveRoots = new Set(drivePrefixes.map((p) => `${cleanFolder(p)}/`));
  const walkBegan = Date.now();
  const walkMs = Math.max(budget - (walkBegan - began), MARKERS_MIN_MS);
  const late = () => Date.now() - walkBegan >= walkMs || tenure.lost;
  let markersLeft = false;
  for (let level = [basePrefix]; level.length;) {
    if (late()) { markersLeft = true; break; }
    const seen = await settleLimit(level, S3_LOOKUPS, async (at) => {
      if (late()) { markersLeft = true; return []; }
      const { marker, folders } = await s3ListLevel(base, at);
      const rel = cleanFolder(at.slice(basePrefix.length));
      if (marker && rel) {
        const there = landingFolder(under, rel);
        if (!insideAnother(`${prefix}/${there}/`, { prefix, drives })) {
          await s3PutFolderMarker(dest, there);
          await s3DeleteObject(base, at);
        }
      }
      return folders.filter((p) => !driveRoots.has(p));
    });
    level = seen.flatMap((s) => (s.ok ? s.value : []));
  }

  return NextResponse.json({ ...count, missingNames, left, stays, ...carried, markersLeft, error });
}
