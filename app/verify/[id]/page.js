import { redirect } from 'next/navigation';
import { getMagicLinkRedirect } from '@/lib/db';
import { loadBrand } from '@/lib/brand-config';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Signing you in' };

/**
 * The second hop of the magic-link flow.
 *
 * The email links here instead of straight to /api/auth/callback/email. That
 * callback's URL — an opaque token and the recipient's address in the query
 * string, clicked as the first hop out of an inbox — is the exact shape Google
 * Safe Browsing flags as phishing. This page is an ordinary page URL with
 * nothing to flag, and the hop to the real callback is a same-origin
 * navigation from a page the browser already trusts.
 *
 * It is safe to leave outside the auth middleware: reaching a valid record
 * requires the short id from the email, and the underlying Auth.js token still
 * has to be valid, unexpired and unused.
 */
export default async function VerifyPage({ params }) {
  const row = await getMagicLinkRedirect(params.id);
  if (row?.targetUrl) redirect(row.targetUrl);

  const brand = await loadBrand();
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card" style={{ width: '100%', maxWidth: 400, padding: 32 }}>
        <img src={brand.visual.logo.markPath} alt="" width={40} height={40} style={{ borderRadius: 10, marginBottom: 24 }} />
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>This link has expired</h1>
        <p className="muted small" style={{ marginBottom: 20 }}>
          Sign-in links last 24 hours and work once. Request a fresh one.
        </p>
        <a className="btn btn-primary" href="/signin">Back to sign in</a>
      </div>
    </main>
  );
}
