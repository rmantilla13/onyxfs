import { cache } from 'react';
import { redirect, notFound } from 'next/navigation';
import { loadBrand } from '@/lib/brand-config';
import { getFileById, canAccessFile, canModifyFile, listFilespacesForSpace } from '@/lib/db';
import { getSessionUser } from '@/lib/session';
import { getPrincipal, can } from '@/lib/authz';
import { presignFileUrls } from '@/lib/storage';
import TopNav from '@/app/components/TopNav';
import FileDetail from '@/app/components/file/FileDetail';
import { buildLabel, buildDetail } from '@/lib/version';
import { parseTimecode, secondsOfFrame, toRate, ASSUMED_RATE } from '@/lib/video-time';
import { isFeatureEnabled } from '@/lib/features';
import { effectiveKind } from '@/lib/media';
import { imagePreviewFor } from '@/lib/poster';
import { isReviewableKind } from '@/lib/review';
import { isTranscribableKind } from '@/lib/transcripts';

export const dynamic = 'force-dynamic';

// One query per request for the row, shared by the title and the page.
const fileById = cache((id) => getFileById(id));

export async function generateMetadata({ params }) {
  // The name only for someone who may see the file: the title used to name
  // any file by its id, to anyone signed in.
  try {
    const user = await getSessionUser();
    const file = user ? await fileById(params.id) : null;
    if (!file || file.deletedAt) return { title: 'File' };
    const principal = await getPrincipal(user.email, { person: user.person });
    return { title: (await canAccessFile(file, principal)) ? file.name : 'File' };
  } catch {
    return { title: 'File' };
  }
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

/**
 * Whether an image shown here from its original could get a large preview
 * from it (lib/poster.js imagePreviewFor): not a GIF, nor a picture its
 * size says is its own preview. Decided here, from the row, so the page
 * hands the original to the fill-in (lib/thumbnail-client.js) — which costs
 * a download past the HTTP cache — only when something could come of it;
 * without a size on the row, the fill-in decides after the decode, and
 * remembers (lib/preview-wanted.js).
 */
function previewPossible(file) {
  const w = Number(file.metadata?.width);
  const h = Number(file.metadata?.height);
  const mime = file.mime || (/\.gif$/i.test(file.name || '') ? 'image/gif' : '');
  if (/gif/i.test(mime)) return false;
  return !(w > 0 && h > 0) || !!imagePreviewFor({ width: w, height: h }, { bytes: file.size, mime });
}

export default async function FilePage({ params, searchParams }) {
  const user = await getSessionUser();
  if (!user) redirect('/signin');
  const { email, avatarUrl } = user;

  const file = await fileById(params.id);
  // A trashed file waits for the purge, and is not a page until it is restored.
  if (!file || file.deletedAt) notFound();

  const principal = await getPrincipal(email, { person: user.person });
  // notFound rather than 403: a refusal that distinguishes "no access" from
  // "no such file" confirms the id exists to someone guessing.
  if (!(await canAccessFile(file, principal))) notFound();

  const [brand, signedList, canWrite, canChange, filespaces] = await Promise.all([
    loadBrand(),
    // Six hours, so a paused video still seeks when it resumes.
    presignFileUrls([file], { expiresIn: 21600 }),
    canModifyFile(file, principal),
    // The file alone, whatever the role: whether a link to it is theirs to make.
    canModifyFile(file, principal, { action: null }),
    // For the nav's filespace switcher.
    listFilespacesForSpace(email, principal),
  ]);
  // Some kind of link is open to them: private, or public and password.
  const linkable = (cap) => can(principal, cap, { canModify: true, expiresInDays: principal.limits.shareMaxExpiryDays }).ok;
  const canShare = canChange && ['shares.private', 'shares.public'].some(linkable);
  // And one that takes comments: a public or password link that is also a
  // review link, to a photo or a video.
  const canReviewLinks = canShare && isReviewableKind(effectiveKind(file)) && ['shares.public', 'review.links'].every(linkable);

  return (
    <>
      <TopNav
        build={{ label: buildLabel(), detail: buildDetail() }}
        brandName={brand.name}
        logo={brand.visual.logo}
        email={email}
        avatarUrl={avatarUrl}
        isAdmin={principal.isAdmin}
        filespaces={filespaces}
      />
      <FileDetail
        file={signedList[0]}
        canWrite={canWrite}
        // Sharing takes a link capability AND write access to the file; the
        // routes check both again.
        canShare={canShare}
        canReviewLinks={canReviewLinks}
        // Back to the folder the file is in, not the top of the library.
        backHref={file.folder ? `/files?folder=${encodeURIComponent(file.folder)}` : '/files'}
        // ?t= opens the player at a moment, so a timecode can be shared as a
        // link. Parsed here rather than in the client so a malformed value is
        // simply absent instead of reaching the player as NaN.
        startAt={startAtFrom(searchParams?.t, file.metadata)}
        // Review: the flag as this person has it, read here on the server;
        // the review routes read it again for themselves.
        review={isFeatureEnabled(principal.flags, 'review') && isReviewableKind(effectiveKind(file))}
        me={email.toLowerCase()}
        // ?c= is a comment to open on — a notification's link.
        focusComment={typeof searchParams?.c === 'string' ? searchParams.c.slice(0, 64) : null}
        previewPossible={previewPossible(file)}
        // Transcripts: the flag as this person has it, for a video or an
        // audio file. The transcript routes read the flag again themselves.
        transcripts={isFeatureEnabled(principal.flags, 'transcripts') && isTranscribableKind(effectiveKind(file))}
        // The Mac app is named after the brand, never "Onyx" hardcoded.
        brandName={brand.name}
      />
    </>
  );
}
