import { loadBrand } from '@/lib/brand-config';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Check your email' };

export default async function CheckEmail() {
  const brand = await loadBrand();
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card" style={{ width: '100%', maxWidth: 400, padding: 32 }}>
        <img src={brand.visual.logo.markPath} alt="" width={40} height={40} style={{ borderRadius: 10, marginBottom: 24 }} />
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>Check your email</h1>
        <p className="muted small" style={{ margin: 0 }}>
          A sign-in link is on its way. It expires in 24 hours and can only be used once.
        </p>
      </div>
    </main>
  );
}
