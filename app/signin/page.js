import { loadBrand } from '@/lib/brand-config';
import SignInClient from './SignInClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in' };

const ERRORS = {
  Configuration: 'Sign-in is misconfigured on the server. An admin can check /api/health for the specific cause.',
  AccessDenied: 'That address is not approved for this workspace.',
  Verification: 'That link has expired or was already used. Request a new one below.',
};

export default async function SignInPage({ searchParams }) {
  const brand = await loadBrand();
  const code = searchParams?.error;
  return (
    <SignInClient
      brandName={brand.name}
      tagline={brand.tagline}
      markPath={brand.visual.logo.markPath}
      oktaEnabled={process.env.NEXT_PUBLIC_OKTA_ENABLED === 'true'}
      error={code ? ERRORS[code] || 'Sign-in failed. Try again.' : null}
    />
  );
}
