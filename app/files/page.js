import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { loadBrand } from '@/lib/brand-config';
import { isAdmin } from '@/lib/auth-allowlist';
import {
  getFeatureFlags, getRolesConfig, listFilespacesForSpace, getFileMetadataSchema, buildPrincipal,
} from '@/lib/db';
import { listFilesPage, listFolderTree } from '@/lib/file-listing';
import { listingKey } from '@/lib/listing-cache';
import { cleanFolder } from '@/lib/folder-ops';
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

  // In a drive, the drive's role decides as well: its viewers see the upload
  // and edit controls go, as the routes behind them now refuse
  // (lib/drive-access.js).
  const filespaceId = searchParams?.filespace || '';
  const activeDrive = filespaces.find((f) => f.id === filespaceId) || null;
  const canWrite = (role.full || role.id !== 'viewer') && (!activeDrive || canWriteDrive(activeDrive.role, admin));

  // The folder in the URL, first page and folder tree, rendered with the
  // page: the directory is in the first paint rather than two requests after
  // it. The same code and the same checks as GET /api/files
  // (lib/file-listing.js); the list of drives above is the viewer's own, so
  // a drive not in it is not theirs and the scope falls back to the library,
  // as the API's does. The client takes this as the answer to its first
  // request (listingKey) and asks for nothing until something changes.
  // Drive usage is not here: it is a sum over whole drives, asked for after
  // the page is on screen (/api/filespaces/usage).
  const folder = cleanFolder(searchParams?.folder || '');
  const storagePrefix = activeDrive ? String(activeDrive.prefix || '').replace(/^\/+|\/+$/g, '') : undefined;
  const principal = await buildPrincipal(email);
  const [page, tree] = await Promise.all([
    // The folder's own files, the top level included — what the client asks
    // for with no search or filter on (fetchListing), which this answers.
    listFilesPage({ principal, opts: { folder, sort: 'new', limit: 100 }, storagePrefix }).catch(() => null),
    listFolderTree({ principal, storagePrefix }).catch(() => null),
  ]);
  const initial = page && tree
    ? {
      key: listingKey({ filespaceId: activeDrive ? filespaceId : '', folder, sort: 'new' }),
      filespaceId: activeDrive ? filespaceId : '',
      files: page.files,
      cursor: page.cursor,
      folders: tree,
    }
    : null;

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
        filespaceId={filespaceId}
        isAdmin={admin}
        drives={filespaces}
        initial={initial}
      />
    </>
  );
}
