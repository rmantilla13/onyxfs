import { redirect } from 'next/navigation';
import { loadBrand } from '@/lib/brand-config';
import { listFilespacesForSpace } from '@/lib/db';
import { getSessionUser } from '@/lib/session';
import { getPrincipal, libraryOpen } from '@/lib/authz';
import { buildLabel, buildDetail } from '@/lib/version';
import TopNav from '@/app/components/TopNav';
import DrivesGrid from './DrivesGrid';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Drives' };

/**
 * /drives — every drive this person can open, as a grid of cards: each one's
 * colour, name and what it holds, and a mosaic of its newest pictures. The
 * sidebar's "Drives" heading opens it; a card opens its drive in Files.
 *
 * The drives are listFilespacesForSpace's, as the files page's sidebar has
 * them (an admin sees every drive, as its owner); All files leads them while
 * there is one (the `library` flag). Usage and the pictures are asked for
 * once the page is on screen, as the files page asks for them — neither
 * holds up the first paint.
 */
export default async function DrivesPage() {
  const user = await getSessionUser();
  if (!user) redirect('/signin?callbackUrl=%2Fdrives');
  const { email, avatarUrl } = user;
  const principal = await getPrincipal(email, { person: user.person });
  const [brand, drivesRead] = await Promise.all([
    loadBrand(),
    listFilespacesForSpace(email, principal, { strict: true }).catch(() => null),
  ]);
  const drives = drivesRead || [];
  const library = libraryOpen(principal);
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
        library={library}
      />
      <DrivesGrid
        drives={drives.map((d) => ({ id: d.id, name: d.name, role: d.role }))}
        library={library}
        failed={drivesRead === null}
      />
    </>
  );
}
