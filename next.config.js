/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // sharp is a native module (libvips). Load it at runtime; never bundle it.
    serverComponentsExternalPackages: ['sharp'],
    // The thumbnail worker shells out to the ffmpeg-static binary through a
    // runtime path string, which Next's file tracing cannot see. Name it
    // explicitly or the deployed function is missing the binary.
    outputFileTracingIncludes: {
      '/api/files/thumbs': ['./node_modules/ffmpeg-static/ffmpeg'],
    },
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.public.blob.vercel-storage.com' },
      { protocol: 'https', hostname: '**.amazonaws.com' },
      { protocol: 'https', hostname: '**.r2.cloudflarestorage.com' },
      { protocol: 'https', hostname: '**.digitaloceanspaces.com' },
    ],
  },
  async headers() {
    // Conservative baseline. The full script/style CSP is deliberately not
    // here: the root layout inlines the brand's custom properties as a <style>
    // block, so a strict policy needs nonces threaded through it. What ships
    // is the frame-ancestors directive, which stops clickjacking and cannot
    // break anything.
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'geolocation=(), camera=(), microphone=(), browsing-topics=()' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
        ],
      },
    ];
  },
};
module.exports = nextConfig;
