import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { loadBrand } from '@/lib/brand-config';
import { listFilespacesForSpace, getFileMetadataSchema, listSavedViews } from '@/lib/db';
import { getSessionUser } from '@/lib/session';
import { getPrincipal, can } from '@/lib/authz';
import { listFilesPage, listFolderTree } from '@/lib/file-listing';
import { listingKey } from '@/lib/listing-cache';
import { cleanFolder } from '@/lib/folder-ops';
import { VIEW_STORAGE_KEY, parseView } from '@/lib/list-columns';
import {
  DEFAULT_VIEW_ID, LOCAL_VIEWS_KEY, SIDEBAR_KEY, resolveView, stateFromView, parseLocalViews, legacyView, visibleViews, toClientView, listingOpts,
} from '@/lib/views';
import { normalizeSchema } from '@/lib/dam';
import { canWriteDrive } from '@/lib/drive-access';
import TopNav from '@/app/components/TopNav';
import FilesClient from './FilesClient';
import { buildLabel, buildDetail } from '@/lib/version';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Files' };

/** A cookie the page set with encodeURIComponent, read back whichever way it arrives. */
function cookieJson(value) {
  if (!value) return null;
  for (const text of [value, (() => { try { return decodeURIComponent(value); } catch { return null; } })()]) {
    if (!text) continue;
    try { return JSON.parse(text); } catch {}
  }
  return null;
}

export default async function FilesPage({ searchParams }) {
  // Signed in, and still allowed to be: not suspended, not signed out
  // everywhere since this session began (lib/session.js). The picture comes
  // from the same query.
  const user = await getSessionUser();
  if (!user) redirect('/signin');
  const { email, avatarUrl } = user;

  // How this browser has the page: its changes to the built-in views, the
  // grid/list choice from before there were views, whether the filter panel
  // was left open and the sidebar shut. The client keeps each in a cookie as
  // well as localStorage, so the page is rendered the way it will be shown —
  // a list from the first byte, not a grid of posters swapped for rows after
  // hydration.
  const jar = cookies();
  const initialLocal = parseLocalViews(cookieJson(jar.get(LOCAL_VIEWS_KEY)?.value));
  const legacyLayout = jar.get(VIEW_STORAGE_KEY)?.value;
  const initialLegacy = legacyView({ layout: legacyLayout ? parseView(legacyLayout) : undefined });
  const initialFiltersOpen = jar.get('onyx.files.filters')?.value === 'open';
  const initialSidebarOpen = jar.get(SIDEBAR_KEY)?.value !== 'closed';

  // One principal for the whole page (lib/authz.js): the flags as this person
  // sees them, their capabilities, and their drives with each role already
  // capped by their platform role.
  const principal = await getPrincipal(email, { person: user.person });
  const admin = principal.isAdmin;
  const [brand, filespaces, rawSchema, savedViews] = await Promise.all([
    loadBrand(),
    // Admins see every filespace (as owner), others their grants. The old
    // listFilespacesForUser left admins with an empty switcher: env-admins are
    // never stored as grant rows.
    listFilespacesForSpace(email, principal),
    getFileMetadataSchema(),
    // Their own views; one whose drive they can no longer open is left out
    // below, as GET /api/views leaves it out. A failed read is no views, not
    // no page.
    listSavedViews(email).catch(() => []),
  ]);
  const { flags } = principal;
  const views = visibleViews(savedViews, filespaces).map(toClientView);

  // In a drive, the drive's role decides as well: its viewers see the upload
  // and edit controls go, as the routes behind them now refuse
  // (lib/drive-access.js).
  const filespaceId = searchParams?.filespace || '';
  const activeDrive = filespaces.find((f) => f.id === filespaceId) || null;
  const canWrite = can(principal, 'files.upload').ok && (!activeDrive || canWriteDrive(activeDrive.role, admin));
  // Whether their role may make a link that takes comments — a public or
  // password link that is also a review link. The Share dialog offers it for
  // photos and videos; the route checks it, the file and its drive again.
  const reviewLinks = ['shares.public', 'review.links']
    .every((cap) => can(principal, cap, { canModify: true, expiresInDays: principal.limits.shareMaxExpiryDays }).ok);

  // The view in the URL (?view=): a built-in, or one of their own. A view
  // kept for one drive opens in that drive, so a link to it lands there; an
  // id that is neither — someone else's, or deleted — is All files.
  const folder = cleanFolder(searchParams?.folder || '');
  const requested = String(searchParams?.view || DEFAULT_VIEW_ID);
  let view = resolveView(requested, { custom: views, local: initialLocal, legacy: initialLegacy });
  if (view && !view.builtin && view.driveId && view.driveId !== (activeDrive ? filespaceId : '')) {
    redirect(`/files?filespace=${encodeURIComponent(view.driveId)}&view=${encodeURIComponent(view.id)}`);
  }
  if (!view) view = resolveView(DEFAULT_VIEW_ID, { local: initialLocal, legacy: initialLegacy });
  const st = stateFromView(view);
  // A search in the URL (?q=) is this view's, as "Filter this view by …"
  // makes it; without one, the view's own.
  const query = String(searchParams?.q || '').trim().slice(0, 200) || st.query;
  const flat = st.display.flatten && st.display.layout !== 'column';

  // The folder in the URL, first page and folder tree, rendered with the
  // page: the directory is in the first paint rather than two requests after
  // it. The same code and the same checks as GET /api/files
  // (lib/file-listing.js), and the same listing the client would ask for
  // (lib/views.js listingOpts); the list of drives above is the viewer's
  // own, so a drive not in it is not theirs and the page falls back to the
  // library (the API refuses such a drive outright; the client is handed
  // no drive, so it never asks for one). The client takes this as the answer to its
  // first request (listingKey) and asks for nothing until something changes.
  // Drive usage is not here: it is a sum over whole drives, asked for after
  // the page is on screen (/api/filespaces/usage).
  const storagePrefix = activeDrive ? String(activeDrive.prefix || '').replace(/^\/+|\/+$/g, '') : undefined;
  const listing = { folder, query, kinds: st.kinds, sort: st.sort, flat };
  const [page, tree] = await Promise.all([
    listFilesPage({ principal, opts: { ...listingOpts(listing), limit: 100 }, storagePrefix }).catch(() => null),
    listFolderTree({ principal, storagePrefix }).catch(() => null),
  ]);
  const initial = page && tree
    ? {
      key: listingKey({ filespaceId: activeDrive ? filespaceId : '', ...listing }),
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
        reviewLinks={reviewLinks}
        schema={normalizeSchema(rawSchema)}
        filespaceId={activeDrive ? filespaceId : ''}
        isAdmin={admin}
        drives={filespaces}
        initial={initial}
        initialFiltersOpen={initialFiltersOpen}
        initialSidebarOpen={initialSidebarOpen}
        view={view}
        views={views}
        initialLocal={initialLocal}
        initialLegacy={initialLegacy}
        initialQuery={query !== st.query ? query : ''}
      />
    </>
  );
}
