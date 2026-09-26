import { redirect } from 'next/navigation';
import { loadBrand } from '@/lib/brand-config';
import { listFilespacesForSpace, getFileMetadataSchema } from '@/lib/db';
import { getSessionUser } from '@/lib/session';
import { getPrincipal, can } from '@/lib/authz';
import { listFilesPage, listFolderTree } from '@/lib/file-listing';
import { listingKey } from '@/lib/listing-cache';
import { cleanFolder } from '@/lib/folder-ops';
import { normalizeSchema } from '@/lib/dam';
import { canWriteDrive } from '@/lib/drive-access';
import TopNav from '@/app/components/TopNav';
import FilesClient from './FilesClient';
import { buildLabel, buildDetail } from '@/lib/version';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Files' };

export default async function FilesPage({ searchParams }) {
  // Signed in, and still allowed to be: not suspended, not signed out
  // everywhere since this session began (lib/session.js). The picture comes
  // from the same query.
  const user = await getSessionUser();
  if (!user) redirect('/signin');
  const { email, avatarUrl } = user;

  // One principal for the whole page (lib/authz.js): the flags as this person
  // sees them, their capabilities, and their drives with each role already
  // capped by their platform role.
  const principal = await getPrincipal(email, { person: user.person });
  const admin = principal.isAdmin;
  const [brand, filespaces, rawSchema] = await Promise.all([
    loadBrand(),
    // Admins see every filespace (as owner), others their grants. The old
    // listFilespacesForUser left admins with an empty switcher: env-admins are
    // never stored as grant rows.
    listFilespacesForSpace(email, principal),
    getFileMetadataSchema(),
  ]);
  const { flags } = principal;

  // In a drive, the drive's role decides as well: its viewers see the upload
  // and edit controls go, as the routes behind them now refuse
  // (lib/drive-access.js).
  const filespaceId = searchParams?.filespace || '';
  const activeDrive = filespaces.find((f) => f.id === filespaceId) || null;
  const canWrite = can(principal, 'files.upload').ok && (!activeDrive || canWriteDrive(activeDrive.role, admin));

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
        avatarUrl={avatarUrl}
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
