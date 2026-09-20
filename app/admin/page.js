import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { isAdmin, isSuperAdmin } from '@/lib/auth-allowlist';
import { loadBrand } from '@/lib/brand-config';
import TopNav from '@/app/components/TopNav';
import AdminClient from './AdminClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin' };

export default async function AdminPage() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect('/signin');
  // Admin access is env-gated (ADMIN_EMAILS), deliberately independent of the
  // role system — a misconfigured role must never lock admins out of the panel
  // that would let them fix it.
  if (!isAdmin(email)) redirect('/files');

  const brand = await loadBrand();
  return (
    <>
      <TopNav brandName={brand.name} markPath={brand.visual.logo.markPath} email={email} isAdmin />
      <AdminClient superAdmin={isSuperAdmin(email)} />
    </>
  );
}
