/**
 * Signing the app's own window into the web, from the device's token.
 * Pure — the route (app/api/desktop/web-session) does the lookups.
 *
 * The Mac app shows the web workspace in a web view, and that web view needs
 * a browser session; the app holds a bearer token. The handoff turns one into
 * the other without a second magic link:
 *
 *   1. the app POSTs, with its token, the S256 challenge of a secret it made
 *   2. the server keeps a one-time code bound to that challenge (60 s)
 *   3. the app sets the secret as a cookie in its web view, then loads the
 *      GET with the code
 *   4. the server checks the cookie against the challenge, spends the code,
 *      and answers with a session cookie and a redirect into the app
 *
 * Step 3 is what stops login CSRF. A code alone would be a link anyone could
 * make for their own account and send to someone else, whose browser would
 * then be quietly signed in as the sender — and upload into the sender's
 * library. Nobody can set a cookie for this site in someone else's browser,
 * so a code works only in the web view of the app that asked for it.
 */

export const HANDOFF_COOKIE = 'onyx_handoff';
export const HANDOFF_TTL_MS = 60 * 1000;
/** The web session it mints: Auth.js's own default lifetime. */
export const WEB_SESSION_MAX_AGE = 30 * 24 * 60 * 60;

/** Auth.js's session cookie name; `__Secure-` over HTTPS, as it names it itself. */
export function sessionCookieName(secure) {
  return `${secure ? '__Secure-' : ''}authjs.session-token`;
}

/**
 * Where to land after the handoff: a path on this site, or /files. Never
 * another origin, and never `//host` (which a browser reads as one) — an
 * open redirect on a sign-in route is a phishing kit.
 */
export function safeNext(next) {
  const s = String(next || '');
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\')) return '/files';
  if (/^\/(signin|verify)(\/|$|\?)/.test(s)) return '/files';
  if (/[\u0000-\u001f]/.test(s)) return '/files';
  return s;
}

/** Is the request HTTPS, as the browser saw it (a proxy may terminate TLS)? */
export function requestIsSecure({ protocol, forwardedProto } = {}) {
  if (String(forwardedProto || '').split(',')[0].trim().toLowerCase() === 'https') return true;
  return String(protocol || '').toLowerCase() === 'https:';
}
