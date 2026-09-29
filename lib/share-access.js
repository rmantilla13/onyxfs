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
// Authorize → filter → presign: nothing here signs a URL. The caller presigns
// only after `state` comes back 'ok'.

import { cookies } from 'next/headers';
import { getShareRow, getFileById, canAccessFile, isLinkCreatorPaused } from '@/lib/db';
import { getSessionUser } from '@/lib/session';
import { getPrincipal, readGlobalFlags } from '@/lib/authz';
import { shareState, shareCookieName, shareCookieValid } from '@/lib/shares';
import { shareKind, shareReview, isShareToken } from '@/lib/share-kinds';
import { effectiveKind } from '@/lib/media';
import { isReviewableKind } from '@/lib/review';

/** What a link's recipients may do besides view: null, 'comment' or 'approve'. */
function reviewLevel(row, file, kind, flags) {
  if (kind === 'private' || !flags?.review) return null;
  if (!isReviewableKind(effectiveKind(file))) return null;
  return shareReview(row);
}

export async function resolveShareAccess(token) {
  if (!isShareToken(token)) return { state: 'missing' };
  const flags = await readGlobalFlags();
  if (!flags?.shares) return { state: 'off' };

  const row = await getShareRow(token);
  const state = shareState(row);
  if (state === 'missing') return { state: 'missing' };
  if (state === 'expired') return { state: 'expired' };
  // Folder and brief rows exist in the table from before; only files are served.
  if ((row.kind || 'file') !== 'file') return { state: 'missing' };
  // Suspending someone pauses the links they made, unless the admin chose
  // otherwise. Reactivating them brings the links back as they were. A read
  // that fails serves nothing: a paused link must not reopen because the
  // database was slow.
  try {
    if (row.created_by && await isLinkCreatorPaused(row.created_by)) return { state: 'paused' };
  } catch {
    return { state: 'unavailable' };
  }

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
    const value = cookies().get(shareCookieName(token))?.value;
    if (shareCookieValid(value, token, row.password_hash, process.env.AUTH_SECRET)) return { state: 'ok', row, file, kind, review, flags };
    return { state: state === 'locked' ? 'locked' : 'password', row, kind };
  }
  return { state: 'ok', row, file, kind, review, flags };
}
