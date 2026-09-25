import Link from 'next/link';
import { loadBrand } from '@/lib/brand-config';
import { latestMacRelease } from '@/lib/mac-release';
import BrandLogo from '@/app/components/BrandLogo';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Download for Mac' };

/**
 * Where to get the Mac app. Public, like the app itself: getting it comes
 * before having signed in on this machine. The button goes through
 * /download/mac, which resolves the newest release when it is pressed.
 */
export default async function DownloadPage() {
  const [brand, release] = await Promise.all([loadBrand(), latestMacRelease()]);
  const published = release?.publishedAt
    ? new Date(release.publishedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : null;

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card download-card">
        <BrandLogo logo={brand.visual.logo} name={brand.name} height={30} markSize={40} className="auth-logo" />
        <h1 style={{ fontSize: 24, marginBottom: 6 }}>{brand.name} for Mac</h1>
        <p className="muted" style={{ margin: '0 0 20px' }}>
          Your whole workspace in a window of its own, and your drives in Finder&rsquo;s sidebar &mdash;
          files download when you open them.
        </p>

        {release ? (
          <>
            <a className="btn btn-primary download-button" href="/download/mac">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
              </svg>
              Download for Mac
            </a>
            <p className="small muted" style={{ margin: '10px 0 0' }}>
              Version {release.version}{published ? ` · ${published}` : ''} · macOS {release.minimumSystemVersion} or later
            </p>
          </>
        ) : (
          <p className="small" style={{ margin: 0 }}>
            The first Mac release has not been published yet. Check back soon.
          </p>
        )}

        <ul className="download-points small">
          <li>Open the download and drag {brand.name} to Applications.</li>
          <li>Sign in with your browser, or with a code from <Link href="/space/pair">Pair a device</Link>.</li>
          <li>Choose which drives appear in Finder in Settings. What you see follows each drive&rsquo;s members.</li>
          <li>It keeps itself up to date: {brand.name} &rsaquo; Check for Updates.</li>
        </ul>

        <p className="small muted" style={{ margin: '16px 0 0' }}>
          <Link href="/files">Back to your files</Link>
        </p>
      </div>
    </main>
  );
}
