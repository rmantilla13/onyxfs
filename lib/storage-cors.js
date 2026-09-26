/**
 * The origins a bucket's CORS rule should let upload from, for "Apply CORS"
 * in Admin → Storage. Pure, so it is tested without a bucket.
 *
 * Browser uploads PUT straight from the page to a presigned URL, so the
 * bucket has to name the page's origin. That is this deployment's own
 * origin and nothing else: the one the request came in on, the one it is
 * configured to live at (NEXT_PUBLIC_APP_URL), and the brand's origin when
 * the brand sets one. It used to add our own production domain to every
 * deployment's bucket, which is someone else's site to a white-label one.
 *
 * `fallbackOrigin` is the origin the brand reports when none is configured
 * (the compiled default). It is left out unless it is also where this
 * deployment actually is, so an unconfigured white-label install does not
 * inherit it. Previews are included only when running on Vercel, where they
 * share the bucket.
 */
export function corsOrigins({ requestOrigin = '', appUrl = '', brandOrigin = '', fallbackOrigin = '', vercel = false } = {}) {
  const origin = (u) => {
    try {
      const x = new URL(String(u || '').trim());
      return x.protocol === 'https:' || x.protocol === 'http:' ? x.origin : '';
    } catch {
      return '';
    }
  };
  const own = [origin(requestOrigin), origin(appUrl)].filter(Boolean);
  const brand = origin(brandOrigin);
  const out = [...own];
  if (brand && (brand !== origin(fallbackOrigin) || own.includes(brand))) out.push(brand);
  if (vercel) out.push('https://*.vercel.app');
  return [...new Set(out)];
}

/** The rule itself, as the provider consoles want it pasted. */
export function corsRule(origins = []) {
  return [{
    AllowedOrigins: origins,
    AllowedMethods: ['PUT', 'GET', 'HEAD', 'POST'],
    AllowedHeaders: ['*'],
    ExposeHeaders: ['ETag'],
    MaxAgeSeconds: 3000,
  }];
}
