import { redirect } from 'next/navigation';
import { isAdmin, isSuperAdmin } from '@/lib/auth-allowlist';
import { getSessionUser } from '@/lib/session';
import { loadBrand } from '@/lib/brand-config';
import TopNav from '@/app/components/TopNav';
import AdminClient from './AdminClient';
import { buildLabel, buildDetail } from '@/lib/version';
import { listFilespacesForSpace } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin' };

export default async function AdminPage({ searchParams }) {
  const user = await getSessionUser();
  if (!user) redirect('/signin');
  const { email, avatarUrl } = user;
  // Admin access is env-gated (ADMIN_EMAILS), deliberately independent of the
  // role system — a misconfigured role must never lock admins out of the panel
  // that would let them fix it.
  if (!isAdmin(email)) redirect('/files');

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
