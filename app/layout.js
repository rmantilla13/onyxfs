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

/**
 * Viewport lives beside metadata rather than in it (Next 14 splits them).
 * viewportFit: cover lets the page paint under the iPhone's home indicator;
 * themeColor tints Safari's chrome to the brand's paper so the sign-in card
 * and the browser bar read as one surface.
 */
export async function generateViewport() {
  const brand = await loadBrand();
  return {
    width: 'device-width',
    initialScale: 1,
    viewportFit: 'cover',
    themeColor: brand.visual.palette.paper,
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
            hardcodes nothing, so re-branding is a settings write.

            dangerouslySetInnerHTML, not a text child. As a child React
            HTML-escapes the string on the server, so 'Inter Tight' was
            served as &#x27;Inter Tight&#x27; — and a <style> element is raw
            text, which the browser does not decode. The font stack was
            therefore invalid CSS, and the client, which does not escape,
            produced different text and failed hydration for the whole root.
            The value is sanitized in brandCssVars. */}
        <style dangerouslySetInnerHTML={{ __html: `:root{${brandCssVars(brand)}}` }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
