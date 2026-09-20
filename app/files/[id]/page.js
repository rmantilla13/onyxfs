import { redirect, notFound } from 'next/navigation';
import { auth } from '@/auth';
import { loadBrand } from '@/lib/brand-config';
import { isAdmin } from '@/lib/auth-allowlist';
import { getFileById, buildPrincipal, canAccessFile, canModifyFile, listFilespacesForUser } from '@/lib/db';
import { presignFileUrls } from '@/lib/storage';
import TopNav from '@/app/components/TopNav';
import FileDetail from '@/app/components/file/FileDetail';
import { buildLabel, buildDetail } from '@/lib/version';

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
export default async function FilePage({ params }) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect('/signin');

  const file = await getFileById(params.id);
  if (!file) notFound();

  const principal = await buildPrincipal(email);
  // notFound rather than 403: a refusal that distinguishes "no access" from
  // "no such file" confirms the id exists to someone guessing.
  if (!(await canAccessFile(file, principal))) notFound();

  const [brand, filespaces, signedList, canWrite] = await Promise.all([
    loadBrand(),
    listFilespacesForUser(email),
    // Six hours, so a paused video still seeks when it resumes.
    presignFileUrls([file], { expiresIn: 21600 }),
    canModifyFile(file, principal),
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
      <FileDetail file={signedList[0]} canWrite={canWrite} />
    </>
  );
}
