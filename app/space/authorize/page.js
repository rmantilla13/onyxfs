import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { loadBrand } from '@/lib/brand-config';
import AuthorizeClient from './AuthorizeClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Connect the desktop app' };

/**
 * Browser half of the desktop PKCE hand-off.
 *
 * The desktop app opens this URL with its code_challenge and state. This page
 * is INSIDE the auth middleware on purpose: an unauthenticated visitor gets
 * bounced to /signin and returned here afterwards, which is exactly the
 * behaviour we want. Only a real browser session can mint a code, so the
 * desktop app inherits the web allowlist rather than having its own.
 */
export default async function AuthorizePage({ searchParams }) {
  const session = await auth();
  if (!session?.user?.email) redirect('/signin');

  const brand = await loadBrand();
  const challenge = searchParams?.code_challenge || '';
  const state = searchParams?.state || '';

  return (
    <AuthorizeClient
      brandName={brand.desktop.productName}
      logo={brand.visual.logo}
      email={session.user.email}
      challenge={challenge}
      state={state}
    />
  );
}
