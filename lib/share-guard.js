// lib/share-guard.js — what the routes that make and change links share
// (app/api/files/[id]/shares for a file's, app/api/files/folders/shares for a
// folder's): how a link is shown to the people who manage it, the second
// check a link that takes comments has to pass, what a person may make and
// change (for a sheet that offers only that), and who may manage a folder's
// links at all.
// Node only: it reaches lib/db.js through lib/authz.js.

import { NextResponse } from 'next/server';
import { can, refusal, shareCapFor, shareKindsForKey, driveRoleOf, libraryOpen, NO_LIBRARY } from '@/lib/authz';
import { getFilespaceForUser, canModifyFolder, canonicalFolder, modifiableLibraryFolders } from '@/lib/db';
import { canWriteDrive } from '@/lib/drive-access';
import { cleanFolder } from '@/lib/folder-ops';
import { linkRootProblem } from '@/lib/folder-links';
import { shareKind, shareReview, SHARE_KINDS, SHARE_EXPIRY, MIN_PASSWORD } from '@/lib/share-kinds';
import { effectiveKind } from '@/lib/media';
import { isReviewableKind } from '@/lib/review';

/**
 * Where a link opens, as a path: the web's dialog puts its own origin in
 * front, and the apps the server they talk to — whichever name the sharer
 * reaches Onyx by, which is the one the link should carry.
 */
export const linkPath = (token) => `/s/${token}`;

/** A link as the share dialog shows it. Never the password or its hash. */
export const presentShare = (s) => ({
  token: s.token,
  path: linkPath(s.token),
  kind: shareKind(s),
  review: shareReview(s),
  expiresAt: s.expiresAt,
  viewCount: s.viewCount,
  createdAt: s.createdAt,
  createdBy: s.createdBy,
});

/**
 * May a link of `kind` take comments — and approvals? The decision a review
 * link takes on top of its kind's own, pure: never a private link, whose
 * people comment on the file itself; only a photo or a video
 * (`reviewable`); then 'review.links' in lib/authz.js — the capability, the
 * `shares` and `review` flags, the file's drives allowing review links, and
 * the role's longest expiry. → can()'s { ok, reason?, status? }.
 */
export function reviewLinkDecision(principal, { kind, reviewable, canModify, driveShareKinds = null, expiresInDays }) {
  if (kind === 'private') {
    return { ok: false, status: 400, reason: 'Private links open only for members, who already comment on the file.' };
  }
  if (!reviewable) return { ok: false, status: 400, reason: 'Only photos and videos can take comments through a link.' };
  return can(principal, 'review.links', { canModify, kind: 'review', driveShareKinds, expiresInDays });
}

/**
 * May the person behind `g` ({ principal, canModify }) let a link to `file`
 * take comments — and approvals? The link kind's own capability is checked
 * by the caller; this is the one a review link takes on top
 * (reviewLinkDecision). Null when allowed; else the Response.
 */
export async function reviewLinkRefusal(g, file, { kind, expiresInDays }) {
  const reviewable = isReviewableKind(effectiveKind(file));
  // The file's drives only when the answer can turn on them.
  const driveShareKinds = kind !== 'private' && reviewable ? await shareKindsForKey(g.principal, file.storageKey) : null;
  const decision = reviewLinkDecision(g.principal, { kind, reviewable, canModify: g.canModify, driveShareKinds, expiresInDays });
  return decision.ok ? null : refusal(decision);
}

// What the people a link reaches may do, least first: 'view' is stored as null.
const LEVELS = ['view', 'comment', 'approve'];
const RANK = { comment: 1, approve: 2 };
const rank = (review) => RANK[review] || 0;

/**
 * May `principal` set what the people `link` reaches may do to `review`
 * (null for view, 'comment' or 'approve')? `link` as a file's list or
 * getShareTarget has it. PATCH /api/files/[id]/shares/[token] decides with
 * this, and the file's list offers each level it allows (linkLevels), so the
 * two cannot disagree.
 *
 * Opening a link up — comments where there were none, approvals where there
 * were only comments — is making a review link, and takes everything making
 * that link would: the link kind's capability and the drive allowing it,
 * then the review link's own checks, all against the link's remaining
 * lifetime (`driveShareKinds` is needed for this only). Closing it down only
 * narrows exposure, so it takes what revoking takes: the link's creator, or
 * anyone who can change the file.
 */
export function linkLevelDecision(principal, link, review, { canModify, driveShareKinds = null, reviewable, now = Date.now() }) {
  const kind = shareKind(link);
  if (rank(review) > rank(link?.review)) {
    const left = link.expiresAt == null ? null : link.expiresAt - now;
    if (left != null && left <= 0) return { ok: false, status: 400, reason: 'This link has expired. Make a new one.' };
    const expiresInDays = left == null ? null : Math.ceil(left / 86400000);
    const made = can(principal, shareCapFor(kind), { canModify, kind, driveShareKinds, expiresInDays });
    if (!made.ok) return made;
    return reviewLinkDecision(principal, { kind, reviewable, canModify, driveShareKinds, expiresInDays });
  }
  return can(principal, 'shares.revoke', { createdBy: link?.createdBy, canModify });
}

/**
 * The levels `principal` may set `link` to, least first: its own, and every
 * other one linkLevelDecision allows — exactly what PATCH on the link would
 * take from someone who may see the list (who may change the file). Its own
 * alone means there is nothing to choose: a private link takes no comments,
 * and a link to a document none. An expired link may still be closed down;
 * the web's dialog offers no choice for one, it being there only to be
 * revoked, and nor does the app.
 */
export function linkLevels(principal, link, { now = Date.now(), ...ctx } = {}) {
  const current = shareReview(link) || 'view';
  return LEVELS.filter((level) => level === current
    || (shareKind(link) !== 'private' && linkLevelDecision(principal, link, level === 'view' ? null : level, { ...ctx, now }).ok));
}

/** A file's link as its list shows it, with the levels this person may set it to. */
export const presentFileShare = (principal, s, ctx) => ({ ...presentShare(s), levels: linkLevels(principal, s, ctx) });

/**
 * What `principal` may make here, for a sheet that offers only that (the
 * iPhone's Share Link): each kind of link, the review levels and the
 * expiries the POST route would accept — asked of can() exactly as the route
 * asks it, with the same resource. The web's pages work out less
 * (canShare, canReviewLinks and folderLinks, in app/files/[id]/page.js and
 * app/files/page.js) and leave the rest to the route's refusal; a phone
 * should not offer what it would only be refused.
 *
 * `folder`: a folder's links, which are public or password and take no
 * comments. `canModify`, `driveShareKinds` and `reviewable` as the route has
 * them for the file or folder.
 *
 * → { kinds, review, expires, maxExpiryDays, passwordMin, reason? }:
 *   kinds          of SHARE_KINDS' ids, in their order
 *   review         the levels past view a public or password link may take:
 *                  ['comment', 'approve'], or [] (not a photo or a video,
 *                  a folder, or not theirs to make)
 *   expires        of SHARE_EXPIRY's ids; the role's longest expiry leaves
 *                  out 'never' and anything past it
 *   maxExpiryDays  that longest expiry, null for none
 *   passwordMin    the shortest password a password link takes
 *   reason         only when nothing may be made: why not, as can() says it
 *                  for the least a link could be (a private link to a file,
 *                  a public one to a folder)
 */
export function linkChoices(principal, { folder = false, canModify = true, driveShareKinds = null, reviewable = false } = {}) {
  const candidates = folder ? ['public', 'password'] : SHARE_KINDS.map((k) => k.id);
  const decide = (kind, days) => can(principal, shareCapFor(kind), { canModify, kind, driveShareKinds, expiresInDays: days });
  const expiries = SHARE_EXPIRY.filter((x) => candidates.some((k) => decide(k, x.days).ok));
  const kinds = candidates.filter((k) => expiries.some((x) => decide(k, x.days).ok));
  const reviewed = !folder && kinds.some((k) => k !== 'private' && expiries.some((x) => decide(k, x.days).ok
    && reviewLinkDecision(principal, { kind: k, reviewable, canModify, driveShareKinds, expiresInDays: x.days }).ok));
  const choices = {
    kinds,
    review: reviewed ? ['comment', 'approve'] : [],
    expires: expiries.map((x) => x.id),
    maxExpiryDays: principal?.isAdmin ? null : (principal?.limits?.shareMaxExpiryDays ?? null),
    passwordMin: MIN_PASSWORD,
  };
  if (!kinds.length) choices.reason = decide(folder ? 'public' : 'private', 1).reason || 'You can’t make links here.';
  return choices;
}

/**
 * The link kinds the drives a folder is in allow — a drive inside another is
 * held to both — for `gate` (folderLinkGate's answer). Null for the
 * library's folders, which are in none: their links never reach into a
 * drive.
 */
export function folderShareKinds(principal, gate) {
  return gate.storagePrefix ? shareKindsForKey(principal, `${gate.storagePrefix}/${gate.name}/`) : Promise.resolve(null);
}

// ── Folders ───────────────────────────────────────────────────────────────
// Who may see, make and revoke the links to a folder: someone with WRITE
// access where the folder lives — as for a file's links, since a public
// link takes what is in it outside the workspace. The same bar the folders
// route sets for restructuring one:
//
//   in a drive     its editors and owners (getFilespaceForWrite's rule,
//                  after the platform role's ceiling); a viewer, or someone
//                  not in it, manages none of its links
//   in the library a folder grant of editor or owner on the folder or a
//                  folder above it (canModifyFolder)
//   admins         every folder, as everywhere
//
// Making one takes the link kind's capability on top (the POST route).

const deny = (status, error) => ({ error: NextResponse.json({ error }, { status }) });

/**
 * The folder a request names — `folder` in the drive `filespaceId`, or in the
 * library without one — if `principal` may manage its links. → { name, tag,
 * storagePrefix, driveId, driveName } (`name` as the scope stores the path:
 * composed and spelled as the folder there is spelled, lib/db.js
 * canonicalFolder; `storagePrefix` the drive's, null for the library), or
 * { error } to return: 400 for a path that is not a folder's, 403 for one
 * that is not theirs to share. Nothing about the folder is read before the
 * drive answers yes, and whether it exists is the caller's question after.
 */
export async function folderLinkGate(principal, { filespaceId = null, folder } = {}) {
  const problem = linkRootProblem(folder);
  if (problem) return deny(400, problem);
  let tag = '';
  let driveRole = null;
  let drive = null;
  if (!filespaceId && !libraryOpen(principal)) return deny(400, NO_LIBRARY);
  if (filespaceId) {
    drive = await getFilespaceForUser(principal.email, String(filespaceId), principal);
    if (!drive) return deny(403, 'No access to that drive.');
    if (!canWriteDrive(drive.role, principal.isAdmin)) return deny(403, 'You can view this drive but not share its folders.');
    tag = cleanFolder(drive.prefix);
    driveRole = drive.role;
  }
  const name = await canonicalFolder(folder, drive ? { tag, prefix: tag } : {});
  if (!name) return deny(400, 'Choose a folder to share.');
  if (!(await canModifyFolder(name, principal, { driveRole, tag }))) {
    return deny(403, 'You can view this folder but not share it.');
  }
  return { name, tag, storagePrefix: drive ? tag : null, driveId: drive ? drive.id : null, driveName: drive ? drive.name : null };
}

/**
 * The audit subject for a folder's links: which scope and which path, the
 * same for making one and revoking it, so a folder's history reads as one.
 */
export function folderLinkSubject({ storagePrefix = null, folder, driveName = null } = {}) {
  return {
    type: 'folder',
    id: storagePrefix ? `drive:${storagePrefix}/${folder}` : `library:${folder}`,
    label: driveName ? `${driveName} / ${folder}` : folder,
  };
}

/**
 * Whether `principal` may manage the folder a stored link points at
 * (getShareTarget's { folder, storagePrefix }) — the rule above, for a
 * revoke, where the link says which folder and which scope. A drive's link:
 * their role in the drive at that prefix (the best, should two drives in
 * different buckets share it). The library's: their folder grants.
 */
export async function folderLinkWritable(principal, target) {
  if (principal?.isAdmin) return true;
  const root = target?.folder ? cleanFolder(target.folder) : '';
  if (!root) return false;
  const sp = target.storagePrefix ? cleanFolder(target.storagePrefix) : '';
  if (!sp) return canModifyFolder(root, principal, { tag: '' });
  const drives = principal?.driveScope?.drives || [];
  const roles = principal?.driveScope?.roles || {};
  return drives.some((d) => cleanFolder(d.prefix) === sp && canWriteDrive(roles[d.id]));
}

/**
 * A folder tree (lib/file-listing.js listFolderTree, for the drive
 * `filespaceId` or the library without one) with `share: true` on each
 * folder whose links `principal` may manage — folderLinkGate's rule, asked
 * for every folder at once rather than of the route one folder at a time:
 * in a drive, its editors and owners, for all of its folders; in the
 * library, an editor or owner folder grant on the folder or a folder above
 * it; admins, every one. A path no link may be made to (linkRootProblem) is
 * never marked. Unmarked is false, so a tree nobody may share from is the
 * tree as it was.
 *
 * This is the folder's half, as a listing's `can.share` is a file's: whether
 * the person may share at all — the `shares` flag as they see it — is the
 * other half, which the app reads once (/api/space/filespaces) as the web's
 * menus read the flag. The routes decide again, every time.
 */
export async function markFolderLinks(folders, principal, { filespaceId = null } = {}) {
  if (!Array.isArray(folders) || !folders.length || !principal) return folders;
  let may;
  if (principal.isAdmin) {
    may = () => true;
  } else if (filespaceId) {
    const drive = (principal.driveScope?.drives || []).find((d) => d.id === String(filespaceId));
    const all = !!drive && !!cleanFolder(drive.prefix) && canWriteDrive(driveRoleOf(principal, drive.id));
    may = () => all;
  } else {
    const mine = await modifiableLibraryFolders(folders.map((f) => f?.folder), principal);
    may = (path) => mine.has(path);
  }
  return folders.map((f) => (f?.folder && may(f.folder) && !linkRootProblem(f.folder) ? { ...f, share: true } : f));
}
