// lib/share-access.js — what a visitor to /s/<token> gets. Server-only.
//
// One decision, used by the page, the download and the password form, so the
// three cannot disagree about who is let in. In order:
//
//   the `shares` flag   off blocks existing links too, not only new ones —
//                       and so does a flag that cannot be read: the old
//                       fallback to the defaults turned sharing back on
//                       whenever the settings read failed
//   the row             missing, or expired
//   the creator         suspended with "pause their links" set: paused
//   the file            deleted or in the trash: the link goes with it
//   private             signed in, and able to open the file anyway — the
//                       link grants nothing the ACL does not
//   password            a valid unlock cookie (lib/shares.js), else the
//                       password form, else locked out after too many guesses
//   public              in
//
// And, once in, what they may do besides look (`review`): comment, or
// comment and approve, when the link says so — a public or password link to
// a photo or a video, with the `review` flag on. Otherwise null, and the link
// is the view-only link it always was. With it, the flags this was decided
// under (`flags`), for what the page serves besides the file: a visitor has
// none of their own, so these say whether a heavy video's proxy is served.
//
// A link to a FOLDER (file_shares.kind 'folder') passes the same gates, in
// the same order, with its folder in the file's place: the scope it reaches
// has to still be there (lib/folder-links.js folderLinkScope — its drive not
// gone, the folder not in a drive that stopped allowing such links), and it
// is only ever public or password-protected. What it shows is then decided
// live on every request (folderLinkListing, folderLinkFile): the files in
// the folder now, not when the link was made.
//
// So one more gate, which a file link does not need: whoever made it must
// still be able to manage the folder's links (lib/share-guard.js
// folderLinkWritable — an editor or owner of its drive, or of the library
// folder by grant). A file link hands out the one file its maker could
// share; a folder link hands out whatever is put in the folder after, and
// must not go on doing that for someone who has since lost the folder. Their
// link reads as paused, and comes back if they are given it again.
//
// Authorize → filter → presign: nothing here signs a URL until `state` is
// 'ok' — the file link's caller presigns; for a folder, the rows of one page
// are filtered to the link in the query and only those are signed.

import { cookies } from 'next/headers';
import {
  getShareRow, getFileById, canAccessFile, isLinkCreatorPaused, loadDriveGrants,
  listFolderLinkFiles, countFolderLinkFiles, listFolderLinkFolders, getFolderLinkFile,
} from '@/lib/db';
import { getSessionUser } from '@/lib/session';
import { getPrincipal, readGlobalFlags } from '@/lib/authz';
import { getStorageConfig, presignFileUrls } from '@/lib/storage';
import { shareState, shareCookieName, shareCookieValid } from '@/lib/shares';
import { shareKind, shareReview, isShareToken } from '@/lib/share-kinds';
import { effectiveKind } from '@/lib/media';
import { isReviewableKind } from '@/lib/review';
import { encodeCursor } from '@/lib/file-query';
import { folderLinkScope, folderWithin, fileInLink, isLinkFileId, linkTile, LINK_PAGE } from '@/lib/folder-links';
import { folderLinkWritable } from '@/lib/share-guard';

/** What a link's recipients may do besides view: null, 'comment' or 'approve'. */
function reviewLevel(row, file, kind, flags) {
  if (kind === 'private' || !flags?.review) return null;
  if (!isReviewableKind(effectiveKind(file))) return null;
  return shareReview(row);
}

/**
 * The gates every link passes before what it points at is looked at: the
 * token's shape, the `shares` flag, the row and its expiry, and a paused
 * creator. `only` ('file' | 'folder') is the one kind a caller serves; any
 * other reads as missing, as it always has for the file routes. →
 * { state, target } — and { row, flags } when the state is 'ok' or 'locked'.
 */
async function openLink(token, only = null) {
  if (!isShareToken(token)) return { state: 'missing' };
  const flags = await readGlobalFlags();
  if (!flags?.shares) return { state: 'off' };

  const row = await getShareRow(token);
  const state = shareState(row);
  if (state === 'missing') return { state: 'missing' };
  const target = row.kind || 'file';
  if (state === 'expired') return { state: 'expired', target };
  // Brief rows exist in the table from before; only files and folders are served.
  if ((only && target !== only) || (target !== 'file' && target !== 'folder')) return { state: 'missing' };
  // Suspending someone pauses the links they made, unless the admin chose
  // otherwise. Reactivating them brings the links back as they were. A read
  // that fails serves nothing: a paused link must not reopen because the
  // database was slow.
  try {
    if (row.created_by && await isLinkCreatorPaused(row.created_by)) return { state: 'paused', target };
  } catch {
    return { state: 'unavailable', target };
  }
  return { state, target, row, flags };
}

const passed = (o) => o.state === 'ok' || o.state === 'locked';

/** The password gate: the unlock cookie for this link and its current hash. */
function unlocked(token, row) {
  const value = cookies().get(shareCookieName(token))?.value;
  return shareCookieValid(value, token, row.password_hash, process.env.AUTH_SECRET);
}

/** A file link, once past openLink. */
async function fileAccess(token, { row, flags, state }) {
  const file = await getFileById(row.file_id);
  if (!file || file.deletedAt) return { state: 'gone' };

  const kind = shareKind(row);
  if (kind === 'private') {
    const user = await getSessionUser();
    const email = user?.email;
    if (!email) return { state: 'signin', kind };
    const principal = await getPrincipal(email, { person: user.person });
    if (!(await canAccessFile(file, principal))) return { state: 'denied', kind, email };
    return { state: 'ok', row, file, kind, email, flags };
  }
  const review = reviewLevel(row, file, kind, flags);
  if (kind === 'password') {
    if (unlocked(token, row)) return { state: 'ok', row, file, kind, review, flags };
    return { state: state === 'locked' ? 'locked' : 'password', row, kind };
  }
  return { state: 'ok', row, file, kind, review, flags };
}

/**
 * May the person who made a folder link still manage the folder's links?
 * Their principal as it is now (lib/authz.js getPrincipal — role, drive
 * roles after its ceiling, folder grants), held to the rule the routes that
 * make and revoke links hold them to. A link with no maker on record speaks
 * for nobody. Throws when their permissions cannot be read (a degraded
 * principal), so the caller says "try again" rather than guessing either way.
 */
async function creatorMayShare(row, scope) {
  if (!row.created_by) return false;
  const principal = await getPrincipal(row.created_by);
  if (principal.degraded && !principal.isAdmin) throw new Error('permissions unreadable');
  return folderLinkWritable(principal, { folder: scope.root, storagePrefix: scope.library ? null : scope.prefix });
}

/**
 * A folder link, once past openLink: the scope it reaches, from its row and
 * the drives there are now; whether its maker may still share the folder;
 * then the password. Reading the drives, the storage config or the maker's
 * permissions failing serves nothing ('unavailable') rather than a scope
 * guessed without them — the drive boundary is drawn from that list.
 */
async function folderAccess(token, { row, flags, state }) {
  let drives;
  let libraryPrefix;
  try {
    [drives, libraryPrefix] = await Promise.all([
      loadDriveGrants(null).then((g) => g.drives),
      getStorageConfig({ strict: true }).then((c) => c.prefix),
    ]);
  } catch {
    return { state: 'unavailable', target: 'folder' };
  }
  const scope = folderLinkScope({ row, drives, libraryPrefix });
  if (scope.state) return { state: scope.state, target: 'folder' };
  try {
    if (!(await creatorMayShare(row, scope))) return { state: 'paused', target: 'folder' };
  } catch {
    return { state: 'unavailable', target: 'folder' };
  }
  if (scope.kind === 'password' && !unlocked(token, row)) {
    return { state: state === 'locked' ? 'locked' : 'password', target: 'folder', row, kind: scope.kind };
  }
  return { state: 'ok', target: 'folder', row, kind: scope.kind, flags, scope };
}

/** A link to a file, for the routes that serve only those (the download, the review routes). */
export async function resolveShareAccess(token) {
  const o = await openLink(token, 'file');
  if (!passed(o)) return { state: o.state };
  return fileAccess(token, o);
}

/** A link to a folder, for the routes that serve only those (its listing, previews and downloads). */
export async function resolveFolderShareAccess(token) {
  const o = await openLink(token, 'folder');
  if (!passed(o)) return { state: o.state, target: 'folder' };
  return folderAccess(token, o);
}

/**
 * Either, for the page at /s/<token>, which shows both: resolveShareAccess's
 * answer for a file link, resolveFolderShareAccess's for a folder, each with
 * `target` ('file' | 'folder' | null when it is not known) so the page can
 * say which it is.
 */
export async function resolveLinkAccess(token) {
  const o = await openLink(token);
  if (!passed(o)) return { state: o.state, target: o.target || null };
  if (o.target === 'folder') return folderAccess(token, o);
  return { ...(await fileAccess(token, o)), target: 'file' };
}

/**
 * One page of a folder link at `sub` (a subfolder path relative to the link's
 * folder, already checked by lib/folder-links.js linkSubpath). `access` is an
 * 'ok' answer from above — authorized. Filtered to the link in the queries,
 * then only this page's rows are signed, and each is cut down to what a card
 * draws (linkTile). `withFolders` adds the subfolders and the file count, for
 * the page; the "more" requests want only the next files.
 *
 * → { files, cursor, folders?, count? }, or { state: 'unavailable' } when the
 * database did not answer.
 */
export async function folderLinkListing(access, { sub = '', cursor = null, limit = LINK_PAGE, withFolders = true } = {}) {
  const { scope } = access;
  const at = folderWithin(scope.root, sub);
  try {
    const [page, folders, count] = await Promise.all([
      listFolderLinkFiles(scope, { at, cursor, limit }),
      withFolders ? listFolderLinkFolders(scope, { at }) : null,
      withFolders ? countFolderLinkFiles(scope, { at }) : null,
    ]);
    const signed = await presignFileUrls(page.files, { filmstrip: false });
    return {
      files: signed.map(linkTile),
      cursor: encodeCursor(page.cursor),
      ...(withFolders ? { folders, count } : {}),
    };
  } catch (e) {
    console.warn('[folder link] listing failed:', e.message);
    return { state: 'unavailable' };
  }
}

/**
 * One file of a folder link by its id, if the link reaches it now, else null
 * — unsigned, for the caller to sign only once it has it. The query holds it
 * to the link; fileInLink looks at the one row again before it goes out.
 */
export async function folderLinkFile(access, id) {
  if (!isLinkFileId(id)) return null;
  const file = await getFolderLinkFile(access.scope, id);
  return file && fileInLink(file, access.scope) ? file : null;
}
