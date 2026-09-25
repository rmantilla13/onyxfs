import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { loadBrand } from '@/lib/brand-config';
import { isAdmin } from '@/lib/auth-allowlist';
import {
  getFeatureFlags, getRolesConfig, listFilespacesForSpace, getFileMetadataSchema, countFilesUnderPrefix, libraryUsage,
} from '@/lib/db';
import { resolveRole, effectiveFlags } from '@/lib/roles';
import { applyBetaAdminFlags } from '@/lib/features';
import { normalizeSchema } from '@/lib/dam';
import { canWriteDrive } from '@/lib/drive-access';
import TopNav from '@/app/components/TopNav';
import FilesClient from './FilesClient';
import { buildLabel, buildDetail } from '@/lib/version';

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
    // Admins see every filespace (as owner), others their grants. The old
    // listFilespacesForUser left admins with an empty switcher: env-admins are
    // never stored as grant rows.
    listFilespacesForSpace(email),
    getFileMetadataSchema(),
  ]);

  // Global flags → admin beta overrides → narrowed by role. The role can only
  // take features away, never grant one the platform has off.
  const role = resolveRole(email, rolesConfig, { isAdmin: admin });
  const flags = effectiveFlags(applyBetaAdminFlags(globalFlags, admin), role);

  // What each drive holds, shown like a disk's usage — to the people who look
  // after it (admins, and its owners). A viewer's count would include files
  // hidden from them, so they see the drive and their access, not a total.
  // The library's total is an admin's alone for the same reason.
  const [usageRows, library] = await Promise.all([
    Promise.all(filespaces
      .filter((f) => admin || f.role === 'owner')
      .map(async (f) => [f.id, await countFilesUnderPrefix(f.prefix).catch(() => null)])),
    admin ? libraryUsage().catch(() => null) : null,
  ]);
  const driveUsage = Object.fromEntries(usageRows.filter(([, u]) => u));

  // In a drive, the drive's role decides as well: its viewers see the upload
  // and edit controls go, as the routes behind them now refuse
  // (lib/drive-access.js).
  const activeDrive = filespaces.find((f) => f.id === searchParams?.filespace) || null;
  const canWrite = (role.full || role.id !== 'viewer') && (!activeDrive || canWriteDrive(activeDrive.role, admin));

  return (
    <>
      <TopNav
        build={{ label: buildLabel(), detail: buildDetail() }}
        brandName={brand.name}
        logo={brand.visual.logo}
        email={email}
        isAdmin={admin}
        filespaces={filespaces}
      />
      <FilesClient
        flags={flags}
        canWrite={canWrite}
        schema={normalizeSchema(rawSchema)}
        filespaceId={searchParams?.filespace || ''}
        isAdmin={admin}
        drives={filespaces}
        driveUsage={driveUsage}
        library={library}
      />
    </>
  );
}
