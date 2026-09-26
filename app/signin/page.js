import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/session';
import { readGlobalFlags } from '@/lib/authz';
import { loadBrand } from '@/lib/brand-config';
import { printsSignInLinks } from '@/lib/signin-email';
import { safeReturnPath } from '@/lib/return-path';
import SignInClient from './SignInClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in' };

const ERRORS = {
  Configuration: 'Sign-in is misconfigured on the server. An admin can check /api/health for the specific cause.',
  AccessDenied: 'That address is not approved for this workspace, or its access is paused.',
  Verification: 'That link has expired or was already used. Request a new one below.',
};

export default async function SignInPage({ searchParams }) {
  // Middleware leaves /signin unguarded (it has to), so this page is the one
  // that has to notice an already signed-in visitor — including the one the
  // magic-link callback just delivered here — and send them to the library.
  const code = searchParams?.error;
  // Where they were going: a deep link the middleware bounced here, or a
  // private share link. Only ever a path on this site.
  const returnTo = safeReturnPath(searchParams?.callbackUrl);
  // getSessionUser rather than the bare session: a suspended person, or one
  // signed out everywhere, still holds a cookie, and bouncing them to the
  // library would bounce them straight back here.
  if (!code) {
    if (await getSessionUser()) redirect(returnTo || '/files');
  }

  // Unread flags hide the offer; the action refuses on the same terms.
  const [brand, flags] = await Promise.all([loadBrand(), readGlobalFlags()]);
  return (
    <SignInClient
      brandName={brand.name}
      tagline={brand.tagline}
      logo={brand.visual.logo}
      oktaEnabled={process.env.NEXT_PUBLIC_OKTA_ENABLED === 'true'}
      linksPrinted={printsSignInLinks()}
      returnTo={returnTo}
      error={code ? ERRORS[code] || 'Sign-in failed. Try again.' : null}
      requestsEnabled={!!flags?.inviteRequests}
    />
  );
}
