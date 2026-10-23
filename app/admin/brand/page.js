import { isDbConfigured, getBrandConfig, getShareBrands, countLinksByKit } from '@/lib/db';
import { loadBrand, darkPalette, defaultBrandConfig, sanitizeBrandSubmission } from '@/lib/brand-config';
import { readKits } from '@/lib/share-brands';
import { requireAdminPage } from '../_lib/guard';
import AdminPage, { AdminCard } from '../_ui/AdminPage';
import AdminState from '../_ui/AdminState';
import BrandKits from './BrandKits';
import BrandForm from './BrandForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Brand · Admin' };

const DESCRIPTION = 'How the workspace looks, and the brand kits a share link’s page can wear instead: another logo, accent and display font, chosen by whoever makes the link.';

/**
 * Admin → Brand: the workspace brand (lib/brand-config.js — the name,
 * colours, type and marks every page is drawn in) and the brand kits share
 * links may wear (lib/share-brands.js). A server component with two client
 * parts, the kits and the form, which write through /api/admin/brand and
 * /api/admin/brand/kits and read the page again once saved.
 *
 * Both are read fresh and strictly: a form shown empty because a read timed
 * out would, once saved, write that emptiness over the brand. A read that
 * fails is this section's error page instead (error.js), with Retry.
 *
 * `surfaces` is the page colour of a share page in each scheme, and its
 * quiet text, from the resolved brand: a kit's logos are previewed on what
 * they will sit on, whichever scheme the admin has on.
 */
export default async function BrandPage() {
  await requireAdminPage('/admin/brand');
  if (!isDbConfigured()) {
    return (
      <AdminPage title="Brand" description={DESCRIPTION}>
        <AdminState kind="empty" title="Nowhere to keep a brand" message="No database is connected, so neither the brand nor a kit can be saved." />
      </AdminPage>
    );
  }
  const [config, stored, counts, brand] = await Promise.all([
    getBrandConfig({ fresh: true, strict: true }),
    getShareBrands({ fresh: true, strict: true }),
    countLinksByKit().catch(() => ({})),
    loadBrand(),
  ]);
  const kits = readKits(stored).map((k) => ({ ...k, links: counts[k.id] || 0 }));
  const dark = darkPalette(brand.visual.palette);
  const surfaces = {
    light: { paper: brand.visual.palette.paper, muted: brand.visual.palette.muted },
    dark: { paper: dark.paper, muted: dark.muted },
  };

  return (
    <AdminPage title="Brand" description={DESCRIPTION}>
      <AdminCard
        title="Brand kits"
        id="kits"
        hint="A sharer picks a kit under “How the page looks” in the Share dialog, and the link’s page shows its logo and colours. Only admins set a kit’s images, so a link can never show a logo its sharer typed. A password page wears the kit’s colour, and its logo once the password is in."
      >
        <BrandKits kits={kits} accent={brand.visual.palette.accent.toUpperCase()} surfaces={surfaces} />
      </AdminCard>
      <AdminCard
        title="Workspace brand"
        id="workspace"
        hint="What every page is drawn in, links included. A field left blank uses the default shown in it."
      >
        <BrandForm config={sanitizeBrandSubmission(config)} defaults={defaultBrandConfig()} />
      </AdminCard>
    </AdminPage>
  );
}
