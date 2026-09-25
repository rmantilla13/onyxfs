import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { loadBrand } from '@/lib/brand-config';
import { printsSignInLinks } from '@/lib/signin-email';
import SignInClient from './SignInClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in' };

const ERRORS = {
  Configuration: 'Sign-in is misconfigured on the server. An admin can check /api/health for the specific cause.',
  AccessDenied: 'That address is not approved for this workspace.',
  Verification: 'That link has expired or was already used. Request a new one below.',
};

export default async function SignInPage({ searchParams }) {
  // Middleware leaves /signin unguarded (it has to), so this page is the one
  // that has to notice an already signed-in visitor — including the one the
  // magic-link callback just delivered here — and send them to the library.
  const code = searchParams?.error;
  if (!code) {
    const session = await auth();
    if (session?.user) redirect('/files');
  }

  const brand = await loadBrand();
  return (
    <SignInClient
      brandName={brand.name}
      tagline={brand.tagline}
      markPath={brand.visual.logo.markPath}
      oktaEnabled={process.env.NEXT_PUBLIC_OKTA_ENABLED === 'true'}
      linksPrinted={printsSignInLinks()}
      error={code ? ERRORS[code] || 'Sign-in failed. Try again.' : null}
    />
  );
}
