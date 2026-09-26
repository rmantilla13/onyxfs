import { redirect, notFound } from 'next/navigation';
import { auth } from '@/auth';
import { loadBrand } from '@/lib/brand-config';
import { isAdmin } from '@/lib/auth-allowlist';
import { getFileById, buildPrincipal, canAccessFile, canModifyFile, listFilespacesForSpace, getAvatarUrl } from '@/lib/db';
import { presignFileUrls } from '@/lib/storage';
import TopNav from '@/app/components/TopNav';
import FileDetail from '@/app/components/file/FileDetail';
import { buildLabel, buildDetail } from '@/lib/version';
import { parseTimecode, secondsOfFrame, toRate, ASSUMED_RATE } from '@/lib/video-time';
import { flagsForUser } from '@/lib/user-flags';
import { isFeatureEnabled } from '@/lib/features';
import { effectiveKind } from '@/lib/media';
import { isReviewableKind } from '@/lib/review';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }) {
  const file = await getFileById(params.id).catch(() => null);
  return { title: file?.name || 'File' };
}

/**
 * A file, as its own page and its own URL — so it can be linked, refreshed
 * and opened in a new tab.
 *
 * The same component is meant to render inside an intercepted modal over the
 * grid later. Building the plain page first means that if intercepting
 * routes misbehave there is already a working, shareable detail view rather
 * than a half-finished one.
 */
/**
 * Seconds from `?t=`. Accepts plain seconds ("90"), clock time ("1:30") and
 * SMPTE ("01:00:12:04", or "01:00:12;04" drop-frame) read against the file's
 * own frame model — so a timecode copied out of the NLE lands on the frame the
 * NLE showed — and refuses anything else rather than passing NaN to the
 * player, where it would set currentTime and throw. The time is the middle of
 * the frame (secondsOfFrame): the one instant every browser agrees is on it.
 */
function startAtFrom(value, metadata = {}) {
  const fps = toRate(metadata.fps) || ASSUMED_RATE;
  const frame = parseTimecode(Array.isArray(value) ? value[0] : value, {
    fps, tcStart: metadata.tcStart || 0, dropFrame: !!metadata.dropFrame,
  });
  return frame != null && frame >= 0 ? secondsOfFrame(frame, fps) : 0;
}

export default async function FilePage({ params, searchParams }) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect('/signin');
  // The account menu's picture, or null for initials; never throws.
  const avatarUrl = await getAvatarUrl(email);

  const file = await getFileById(params.id);
  // A trashed file waits for the purge, and is not a page until it is restored.
  if (!file || file.deletedAt) notFound();

  const principal = await buildPrincipal(email);
  // notFound rather than 403: a refusal that distinguishes "no access" from
  // "no such file" confirms the id exists to someone guessing.
  if (!(await canAccessFile(file, principal))) notFound();

  const [brand, signedList, canWrite, filespaces, access] = await Promise.all([
    loadBrand(),
    // Six hours, so a paused video still seeks when it resumes.
    presignFileUrls([file], { expiresIn: 21600 }),
    canModifyFile(file, principal),
    // For the nav's filespace switcher.
    listFilespacesForSpace(email),
    flagsForUser(email),
  ]);

  return (
    <>
      <TopNav
        build={{ label: buildLabel(), detail: buildDetail() }}
        brandName={brand.name}
        logo={brand.visual.logo}
        email={email}
        avatarUrl={avatarUrl}
        isAdmin={isAdmin(email)}
        filespaces={filespaces}
      />
      <FileDetail
        file={signedList[0]}
        canWrite={canWrite}
        // Sharing takes the role's flag AND write access; the routes check both again.
        canShare={canWrite && !!access.flags.shares}
        // Back to the folder the file is in, not the top of the library.
        backHref={file.folder ? `/files?folder=${encodeURIComponent(file.folder)}` : '/files'}
        // ?t= opens the player at a moment, so a timecode can be shared as a
        // link. Parsed here rather than in the client so a malformed value is
        // simply absent instead of reaching the player as NaN.
        startAt={startAtFrom(searchParams?.t, file.metadata)}
        // Review: the flag as this person has it, read here on the server;
        // the review routes read it again for themselves.
        review={isFeatureEnabled(access.flags, 'review') && isReviewableKind(effectiveKind(file))}
        me={email.toLowerCase()}
        // ?c= is a comment to open on — a notification's link.
        focusComment={typeof searchParams?.c === 'string' ? searchParams.c.slice(0, 64) : null}
      />
    </>
  );
}
