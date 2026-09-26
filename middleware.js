import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from '@/auth.config';
import { legacyAdminUrl } from '@/lib/admin-redirects';

// Built from the Edge-safe config, NOT from @/auth. Importing the full auth
// config here would pull the Postgres driver into the Edge bundle, which has
// no TCP sockets — it builds cleanly and then fails at runtime on every
// request. See auth.config.js. The same goes for everything else imported
// here: lib/admin-redirects.js imports nothing.
const { auth } = NextAuth(authConfig);

/**
 * The sign-in gate (Auth.js, from authConfig's `authorized`), after one
 * redirect that has to happen before any page renders: the old tabbed admin
 * panel's /admin?tab=… addresses, still in bookmarks and the Mac app, go
 * straight to their sections with a 307. Done ahead of the gate because it
 * reveals nothing — a signed-out visitor is then sent to sign in for the
 * section itself, and returns there.
 */
export function middleware(req, ev) {
  const legacy = legacyAdminUrl(req.nextUrl.pathname, req.nextUrl.search);
  if (legacy) return NextResponse.redirect(new URL(legacy, req.url), 307);
  return auth(req, ev);
}
export default middleware;

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
  // api/files/delta The sync enumeration endpoint. Dual-guarded (cookie or
  //                bearer) by resolveActor, and read by native clients that
  //                cannot follow a redirect to a sign-in page. Only this one
  //                path under api/files is excluded — the rest stay behind the
  //                cookie gate.
  // api/health     Has its own admin-or-CRON_SECRET check, and has to stay
  //                reachable when sign-in itself is broken so it can say why.
  // api/cron       Bearer-token authed.
  // signin, verify Must be reachable while signed out — that is the point.
  // download       The Mac app's download page and link. Getting the app
  //                comes before having an account on this machine.
  // s/             Share links. A public or password link has to open for
  //                someone with no account; a private link asks for sign-in
  //                itself (lib/share-access.js) and returns here afterwards.
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
    '/((?!api/auth|api/desktop|api/space|api/files/delta|api/health|api/cron|signin|verify|download|s/|_next/static|_next/image|_vercel|favicon.ico|icon.png|.*\\.(?:png|jpg|jpeg|svg|ico|webp|gif|mp4|woff2?|ttf)$).*)',
  ],
};
