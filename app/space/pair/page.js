import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/session';
import { loadBrand } from '@/lib/brand-config';
import PairClient from './PairClient';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Pairing code' };

/**
 * The fallback for when the custom URL scheme does not survive the round trip —
 * a locked-down browser, a remote session, or a machine where the app is not
 * registered as the scheme handler. The code is bound to this signed-in email
 * when it is minted, so the desktop side needs no PKCE verifier to redeem it.
 */
export default async function PairPage() {
  if (!(await getSessionUser())) redirect('/signin');
  const brand = await loadBrand();
  return <PairClient brandName={brand.desktop.productName} logo={brand.visual.logo} />;
}
