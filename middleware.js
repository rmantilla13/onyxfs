export { auth as middleware } from '@/auth';

export const config = {
  // Run on everything EXCEPT the paths below. Each exclusion is load-bearing:
  //
  // api/auth       Auth.js's own endpoints — excluding them is what makes
  //                signing in possible at all.
  // api/desktop    Desktop device auth. These are cookie-less and guarded by
  //                lib/desktop-guard.js; the one cookie-gated route
  //                (/authorize) self-checks auth() and 401s. Excluded so a
  //                bearer request gets a clean 401 instead of a 302 to a
  //                sign-in page the desktop app cannot render.
  // api/space      Desktop data plane — filespace listing and STS minting,
  //                all bearer-guarded, same reasoning.
  // api/health     Has its own admin-or-CRON_SECRET check, and has to stay
  //                reachable when sign-in itself is broken so it can say why.
  // api/cron       Bearer-token authed.
  // api/share      Public share resolution; visibility is enforced in the
  //                handler, which only serves non-expired, non-revoked rows.
  // signin, verify Must be reachable while signed out — that is the point.
  // s/             Public share links. Same handler-side enforcement.
  // _next, _vercel Framework assets and Vercel's analytics beacons. Without
  //                the _vercel exclusion the `authorized` callback 302s the
  //                analytics script to /signin and nothing is ever recorded.
  // file extensions Anything in /public with an extension, so the mark in the
  //                magic-link email loads without being redirected to /signin.
  //
  // Note that the /space/authorize PAGE (no api/ prefix) stays matched: an
  // unauthenticated user opening the desktop hand-off link SHOULD be sent to
  // sign in and bounced back afterwards.
  matcher: [
    '/((?!api/auth|api/desktop|api/space|api/health|api/cron|api/share|signin|verify|s/|_next/static|_next/image|_vercel|favicon.ico|icon.png|.*\\.(?:png|jpg|jpeg|svg|ico|webp|gif|mp4|woff2?|ttf)$).*)',
  ],
};
