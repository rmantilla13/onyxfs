import './globals.css';
import { loadBrand, brandCssVars } from '@/lib/brand-config';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const brand = await loadBrand();
  return {
    title: { default: brand.name, template: `%s · ${brand.name}` },
    description: brand.description,
    // A private workspace has no business in an index.
    robots: { index: false, follow: false },
    icons: { icon: brand.visual.logo.markPath },
  };
}

export default async function RootLayout({ children }) {
  const brand = await loadBrand();
  const fonts = [brand.visual.fonts.display.url, brand.visual.fonts.body.url].filter(Boolean);
  return (
    <html lang="en">
      <head>
        {fonts.map((href) => (
          <link key={href} rel="stylesheet" href={href} />
        ))}
        {/* The brand as custom properties. globals.css consumes these and
            hardcodes nothing, so re-branding is a settings write. */}
        <style>{`:root{${brandCssVars(brand)}}`}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
