import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { isAdmin, isSuperAdmin } from '@/lib/auth-allowlist';
import { loadBrand } from '@/lib/brand-config';
import TopNav from '@/app/components/TopNav';
import AdminClient from './AdminClient';
import { buildLabel, buildDetail } from '@/lib/version';
import { listFilespacesForSpace, getAvatarUrl } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin' };

export default async function AdminPage({ searchParams }) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect('/signin');
  // Admin access is env-gated (ADMIN_EMAILS), deliberately independent of the
  // role system — a misconfigured role must never lock admins out of the panel
  // that would let them fix it.
  if (!isAdmin(email)) redirect('/files');
  // The account menu's picture, or null for initials; never throws.
  const avatarUrl = await getAvatarUrl(email);

  const [brand, filespaces] = await Promise.all([loadBrand(), listFilespacesForSpace(email)]);
  return (
    <>
      <TopNav
        brandName={brand.name}
        logo={brand.visual.logo}
        email={email}
        avatarUrl={avatarUrl}
        isAdmin
        filespaces={filespaces}
        build={{ label: buildLabel(), detail: buildDetail() }}
      />
      <AdminClient superAdmin={isSuperAdmin(email)} initialTab={searchParams?.tab} />
    </>
  );
}
