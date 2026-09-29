// lib/share-guard.js — what the routes that make and change links share
// (app/api/files/[id]/shares for a file's, app/api/files/folders/shares for a
// folder's): how a link is shown to the people who manage it, the second
// check a link that takes comments has to pass, and who may manage a
// folder's links at all.
// Node only: it reaches lib/db.js through lib/authz.js.

import { NextResponse } from 'next/server';
import { can, refusal, shareKindsForKey } from '@/lib/authz';
import { getFilespaceForUser, canModifyFolder, canonicalFolder } from '@/lib/db';
import { canWriteDrive } from '@/lib/drive-access';
import { cleanFolder } from '@/lib/folder-ops';
import { linkRootProblem } from '@/lib/folder-links';
import { shareKind, shareReview } from '@/lib/share-kinds';
import { effectiveKind } from '@/lib/media';
import { isReviewableKind } from '@/lib/review';

/** A link as the share dialog shows it. Never the password or its hash. */
export const presentShare = (s) => ({
  token: s.token,
  kind: shareKind(s),
  review: shareReview(s),
  expiresAt: s.expiresAt,
  viewCount: s.viewCount,
  createdAt: s.createdAt,
  createdBy: s.createdBy,
});

/**
 * May the person behind `g` ({ principal, canModify }) let a link to `file`
 * take comments — and approvals? The link kind's own capability is checked
 * by the caller; this is the one a review link takes on top
 * ('review.links' in lib/authz.js): the `shares` and `review` flags, the
 * capability, the file's drives allowing review links, and the role's
 * longest expiry. Only a photo or a video, and never a private link, whose
 * people comment on the file itself. Null when allowed; else the Response.
 */
export async function reviewLinkRefusal(g, file, { kind, expiresInDays }) {
  if (kind === 'private') {
    return NextResponse.json({ error: 'Private links open only for members, who already comment on the file.' }, { status: 400 });
  }
  if (!isReviewableKind(effectiveKind(file))) {
    return NextResponse.json({ error: 'Only photos and videos can take comments through a link.' }, { status: 400 });
  }
  const allowed = can(g.principal, 'review.links', {
    canModify: g.canModify,
    kind: 'review',
    driveShareKinds: await shareKindsForKey(g.principal, file.storageKey),
    expiresInDays,
  });
  return allowed.ok ? null : refusal(allowed);
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
