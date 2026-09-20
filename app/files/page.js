import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { loadBrand } from '@/lib/brand-config';
import { isAdmin } from '@/lib/auth-allowlist';
import { getFeatureFlags, getRolesConfig, listFilespacesForUser, getFileMetadataSchema } from '@/lib/db';
import { resolveRole, effectiveFlags } from '@/lib/roles';
import { applyBetaAdminFlags } from '@/lib/features';
import { normalizeSchema } from '@/lib/dam';
import TopNav from '@/app/components/TopNav';
import FilesClient from './FilesClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Files' };

export default async function FilesPage({ searchParams }) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect('/signin');

  const admin = isAdmin(email);
  const [brand, globalFlags, rolesConfig, filespaces, rawSchema] = await Promise.all([
    loadBrand(),
    getFeatureFlags(),
    getRolesConfig(),
    listFilespacesForUser(email),
    getFileMetadataSchema(),
  ]);

  // Global flags → admin beta overrides → narrowed by role. The role can only
  // take features away, never grant one the platform has off.
  const role = resolveRole(email, rolesConfig, { isAdmin: admin });
  const flags = effectiveFlags(applyBetaAdminFlags(globalFlags, admin), role);

  return (
    <>
      <TopNav
        brandName={brand.name}
        markPath={brand.visual.logo.markPath}
        email={email}
        isAdmin={admin}
        filespaces={filespaces}
        activeFilespace={searchParams?.filespace || ''}
      />
      <FilesClient
        flags={flags}
        canWrite={role.full || role.id !== 'viewer'}
        schema={normalizeSchema(rawSchema)}
        filespaceId={searchParams?.filespace || ''}
        filespaces={filespaces}
      />
    </>
  );
}
