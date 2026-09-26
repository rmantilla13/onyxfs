import './admin.css';
import { loadBrand } from '@/lib/brand-config';
import { listFilespacesForSpace, getAvatarUrl, listInviteRequests } from '@/lib/db';
import { buildLabel, buildDetail } from '@/lib/version';
import TopNav from '@/app/components/TopNav';
import SectionRail from '@/app/components/ui/SectionRail';
import { requireAdminPage } from './_lib/guard';
import { railGroups } from './nav';

export const dynamic = 'force-dynamic';

/**
 * The admin panel's frame: the gate, the nav, and the rail beside every
 * section. Each section is its own route with its own data, loading and
 * error states; this loads only what the frame shows — the account menu's
 * picture, the drives for the ⌘K palette, and the pending-requests badge.
 */
export default async function AdminLayout({ children }) {
  const email = await requireAdminPage('/admin');
  const [brand, filespaces, avatarUrl, pending] = await Promise.all([
    loadBrand(),
    listFilespacesForSpace(email).catch(() => []),
    getAvatarUrl(email),
    listInviteRequests({ status: 'pending' }).then((r) => r.length).catch(() => 0),
  ]);
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
      <div className="shell admin-shell">
        <SectionRail label="Admin" groups={railGroups({ pendingRequests: pending })} />
        <main className="admin-main" id="admin-main">{children}</main>
      </div>
    </>
  );
}
