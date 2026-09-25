import { loadBrand } from '@/lib/brand-config';
import { printsSignInLinks } from '@/lib/signin-email';
import BrandLogo from '@/app/components/BrandLogo';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Check your email' };

export default async function CheckEmail() {
  const brand = await loadBrand();
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card" style={{ width: '100%', maxWidth: 400, padding: 32 }}>
        <BrandLogo logo={brand.visual.logo} name={brand.name} height={30} markSize={40} className="auth-logo" />
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>Check your email</h1>
        <p className="muted small" style={{ margin: 0 }}>
          A sign-in link is on its way. It expires in 24 hours and can only be used once.
        </p>
        {printsSignInLinks() && (
          <p className="muted small" style={{ margin: '16px 0 0' }}>
            Local development: nothing is emailed. The link is printed in the terminal running the dev server.
          </p>
        )}
      </div>
    </main>
  );
}
