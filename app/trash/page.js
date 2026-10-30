import { redirect } from 'next/navigation';
import { loadBrand } from '@/lib/brand-config';
import { listFilespacesForSpace } from '@/lib/db';
import { getSessionUser } from '@/lib/session';
import { getPrincipal, can, libraryOpen } from '@/lib/authz';
import { buildLabel, buildDetail } from '@/lib/version';
import { TRASH_RETENTION_DAYS } from '@/lib/storage-report';
import TopNav from '@/app/components/TopNav';
import TrashList from './TrashList';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Trash' };

/**
 * /trash — the deleted files this person may put back, until the daily purge
 * takes them (TRASH_RETENTION_DAYS). The files sidebar's "Trash" opens it.
 *
 * There is one only with the `trash` flag on and a role that may delete:
 * the rule GET /api/files/trash keeps, read here so the page is not offered
 * to someone the list would refuse. Anyone else goes to Files.
 */
export default async function TrashPage() {
  const user = await getSessionUser();
  if (!user) redirect('/signin?callbackUrl=%2Ftrash');
  const { email, avatarUrl } = user;
  const principal = await getPrincipal(email, { person: user.person });
  if (principal.flags?.trash === false || !can(principal, 'files.delete').ok) redirect('/files');
  const [brand, drives] = await Promise.all([
    loadBrand(),
    listFilespacesForSpace(email, principal, { strict: true }).catch(() => []),
  ]);
  return (
    <>
      <TopNav
        build={{ label: buildLabel(), detail: buildDetail() }}
        brandName={brand.name}
        logo={brand.visual.logo}
        email={email}
        avatarUrl={avatarUrl}
        isAdmin={principal.isAdmin}
        filespaces={drives}
        library={libraryOpen(principal)}
      />
      <TrashList viewer={email} retentionDays={TRASH_RETENTION_DAYS} />
    </>
  );
}
