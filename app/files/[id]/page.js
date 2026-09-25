import { redirect, notFound } from 'next/navigation';
import { auth } from '@/auth';
import { loadBrand } from '@/lib/brand-config';
import { isAdmin } from '@/lib/auth-allowlist';
import { getFileById, buildPrincipal, canAccessFile, canModifyFile, listFilespacesForSpace } from '@/lib/db';
import { presignFileUrls } from '@/lib/storage';
import TopNav from '@/app/components/TopNav';
import FileDetail from '@/app/components/file/FileDetail';
import { buildLabel, buildDetail } from '@/lib/version';
import { parseTimecode } from '@/lib/video-time';

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
 * SMPTE ("00:01:23:12"), and refuses anything else rather than passing NaN to
 * the player — where it would set currentTime and throw.
 */
function startAtFrom(value) {
  const seconds = parseTimecode(Array.isArray(value) ? value[0] : value);
  return seconds != null && seconds >= 0 ? seconds : 0;
}

export default async function FilePage({ params, searchParams }) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect('/signin');

  const file = await getFileById(params.id);
  if (!file) notFound();

  const principal = await buildPrincipal(email);
  // notFound rather than 403: a refusal that distinguishes "no access" from
  // "no such file" confirms the id exists to someone guessing.
  if (!(await canAccessFile(file, principal))) notFound();

  const [brand, signedList, canWrite, filespaces] = await Promise.all([
    loadBrand(),
    // Six hours, so a paused video still seeks when it resumes.
    presignFileUrls([file], { expiresIn: 21600 }),
    canModifyFile(file, principal),
    // For the nav's filespace switcher.
    listFilespacesForSpace(email),
  ]);

  return (
    <>
      <TopNav
        build={{ label: buildLabel(), detail: buildDetail() }}
        brandName={brand.name}
        markPath={brand.visual.logo.markPath}
        email={email}
        isAdmin={isAdmin(email)}
        filespaces={filespaces}
      />
      <FileDetail
        file={signedList[0]}
        canWrite={canWrite}
        // Back to the folder the file is in, not the top of the library.
        backHref={file.folder ? `/files?folder=${encodeURIComponent(file.folder)}` : '/files'}
        // ?t= opens the player at a moment, so a timecode can be shared as a
        // link. Parsed here rather than in the client so a malformed value is
        // simply absent instead of reaching the player as NaN.
        startAt={startAtFrom(searchParams?.t)}
      />
    </>
  );
}
