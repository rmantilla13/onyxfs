import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/session';
import { loadBrand } from '@/lib/brand-config';
import { getOAuthClient } from '@/lib/db';
import { checkAuthorize, withQuery } from '@/lib/oauth';
import ConsentClient from './ConsentClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Allow access' };

/**
 * Where an MCP client — Claude — sends a person to allow it into Onyx
 * (lib/oauth.js). Inside the auth middleware on purpose, as the desktop
 * hand-off is: a signed-out visitor signs in and comes back here, so only a
 * real session can mint a code, and the client inherits the web's allowlist.
 *
 * A request that names an unknown client, or an address it did not register,
 * is refused here and sent nowhere.
 */
export default async function OAuthAuthorizePage({ searchParams }) {
  const user = await getSessionUser();
  if (!user) redirect('/signin');
  const brand = await loadBrand();
  const one = (v) => String((Array.isArray(v) ? v[0] : v) || '');
  const client = await getOAuthClient(one(searchParams?.client_id));
  const checked = checkAuthorize(searchParams || {}, client);
  if (checked.error && checked.redirect) {
    redirect(withQuery(checked.redirectUri, { error: checked.error, error_description: checked.description, state: checked.state }));
  }
  return (
    <ConsentClient
      brandName={brand.name}
      logo={brand.visual.logo}
      email={user.email}
      problem={checked.error || null}
      request={checked.value || null}
    />
  );
}
