import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { loadBrand } from '@/lib/brand-config';
import { isAdmin } from '@/lib/auth-allowlist';
import { getFeatureFlags, getRolesConfig, listFilespacesForUser } from '@/lib/db';
import { resolveRole, effectiveFlags, roleCanWrite } from '@/lib/roles';
import { applyBetaAdminFlags } from '@/lib/features';
import TopNav from '@/app/components/TopNav';
import TrashClient from './TrashClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Trash' };

export default async function TrashPage() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect('/signin');

  const admin = isAdmin(email);
  const [brand, globalFlags, rolesConfig, filespaces] = await Promise.all([
    loadBrand(),
    getFeatureFlags(),
    getRolesConfig(),
    listFilespacesForUser(email),
  ]);

  // Global flags → admin beta overrides → narrowed by role, exactly as /files
  // resolves them.
  const role = resolveRole(email, rolesConfig, { isAdmin: admin });
  const flags = effectiveFlags(applyBetaAdminFlags(globalFlags, admin), role);
  // With trash off a delete is immediate and permanent, so this page could
  // only ever list rows left over from when it was on. Send them to the
  // library rather than to a screen that implies deletes are undoable.
  if (!flags.trash) redirect('/files');

  // No filespace prop: the trash listing is not filespace-scoped, so the nav
  // picker here is a jump back into the library rather than a filter on it.
  return (
    <>
      <TopNav
        brandName={brand.name}
        markPath={brand.visual.logo.markPath}
        email={email}
        isAdmin={admin}
        filespaces={filespaces}
      />
      <TrashClient canWrite={roleCanWrite(role)} />
    </>
  );
}
