import { getMagicLinkRedirect } from '@/lib/db';
import { loadBrand } from '@/lib/brand-config';
import VerifyHop from './VerifyHop';

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
 * The hop is made by the browser (VerifyHop), not by a server-side redirect.
 * Mail providers fetch links in incoming mail to scan them — Gmail and
 * Outlook both do, and more aggressively for mail they file as spam. A 307
 * from here would let that fetch follow through to the callback and consume
 * the one-time token before the person ever clicks; a page that navigates
 * from script does not, and carries a button for anyone with script off.
 *
 * It is safe to leave outside the auth middleware: reaching a valid record
 * requires the short id from the email, and the underlying Auth.js token still
 * has to be valid, unexpired and unused.
 */
export default async function VerifyPage({ params }) {
  // The lookup is deadlined, so it can reject rather than hang. Distinguish
  // the two failures: a link that is genuinely spent, and a database that
  // did not answer in time. Telling someone their link expired when it did
  // not sends them round a loop that never ends.
  const [row, brand] = await Promise.all([
    getMagicLinkRedirect(params.id).catch((e) => {
      console.warn('[verify] lookup failed:', e.message);
      return { unavailable: true };
    }),
    loadBrand(),
  ]);

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card" style={{ width: '100%', maxWidth: 400, padding: 32 }}>
        <img src={brand.visual.logo.markPath} alt="" width={40} height={40} style={{ borderRadius: 10, marginBottom: 24 }} />
        {row?.targetUrl ? (
          <VerifyHop targetUrl={row.targetUrl} brandName={brand.name} />
        ) : row?.unavailable ? (
          <>
            <h1 style={{ fontSize: 22, marginBottom: 8 }}>Something went wrong</h1>
            <p className="muted small" style={{ marginBottom: 20 }}>
              We could not check this link just now. It has not been used — try
              again in a moment.
            </p>
            <a className="btn btn-primary" href={`/verify/${params.id}`}>Try again</a>
          </>
        ) : (
          <>
            <h1 style={{ fontSize: 22, marginBottom: 8 }}>This link has expired</h1>
            <p className="muted small" style={{ marginBottom: 20 }}>
              Sign-in links last 24 hours and work once. Request a fresh one.
            </p>
            <a className="btn btn-primary" href="/signin">Back to sign in</a>
          </>
        )}
      </div>
    </main>
  );
}
