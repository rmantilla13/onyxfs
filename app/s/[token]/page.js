import { getShareByToken, getFeatureFlags } from '@/lib/db';
import { loadBrand } from '@/lib/brand-config';
import { presignFileUrls } from '@/lib/storage';
import ShareClient from './ShareClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Shared', robots: { index: false, follow: false } };

/**
 * Public share landing. Outside the auth middleware by design — that is the
 * whole point of a share link — so every access rule is enforced here instead:
 * the feature flag, expiry, the password, and presigning only the rows this
 * token actually covers.
 */
export default async function SharePage({ params, searchParams }) {
  const brand = await loadBrand();
  const flags = await getFeatureFlags();

  // A disabled flag kills existing links too, not just the creation of new
  // ones — otherwise turning sharing off would leave the door open.
  if (flags.shares === false) return <Shell brand={brand} title="Sharing is turned off" body="This workspace is not serving share links." />;

  const share = await getShareByToken(params.token, { password: searchParams?.p });
  if (!share) return <Shell brand={brand} title="Not found" body="This link does not exist or has been revoked." />;
  if (share.expired) return <Shell brand={brand} title="Link expired" body="Ask whoever shared it for a fresh link." />;
  if (share.needsPassword) {
    return <ShareClient brand={{ name: brand.name, mark: brand.visual.logo.markPath }} needsPassword wrong={!!share.wrong} />;
  }

  const files = share.kind === 'folder' ? await presignFileUrls(share.files || []) : await presignFileUrls([share.file]);
  return (
    <ShareClient
      brand={{ name: brand.name, mark: brand.visual.logo.markPath }}
      title={share.kind === 'folder' ? share.folderName : share.file?.name}
      files={files}
    />
  );
}

function Shell({ brand, title, body }) {
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card" style={{ width: '100%', maxWidth: 400, padding: 32 }}>
        <img src={brand.visual.logo.markPath} alt="" width={40} height={40} style={{ borderRadius: 10, marginBottom: 24 }} />
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>{title}</h1>
        <p className="muted small" style={{ margin: 0 }}>{body}</p>
      </div>
    </main>
  );
}
