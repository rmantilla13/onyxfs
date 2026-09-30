// lib/bearer-gate.js — the API paths the native apps call with their device
// token (Onyx for Mac's writes, the iPhone's links), for middleware.js.
// Imports nothing: middleware runs on the Edge, which lib/db.js must never
// reach (auth.config.js says why).
//
// The sign-in gate sends a request with no session to /signin. The Mac's
// upload engine has no session, only its bearer token, and a redirect to a
// page it cannot show is no answer at all. So a request to one of these paths
// that carries `Authorization: Bearer …` goes past the gate to its handler,
// which checks the token itself (lib/authz.js requirePrincipal) and answers in
// JSON. Without the header the gate applies exactly as it always has: a
// signed-out browser is still sent to sign in.
//
// Getting past the gate grants nothing. Every handler here decides who is
// asking on its own, as every API route must; the gate is only ever a
// signed-in check. Keep the list to handlers that take requirePrincipal(req)
// in every method, so a token never reaches a route that could only say 401.

// The static routes beside [id] under /api/files — never a file id.
const SIBLINGS = '(?:config|delta|folders|presign|upload)';
// A file id followed by more path: any segment but one of those.
const FILE_ID = `(?!${SIBLINGS}/)[^/]+`;

export const BEARER_PATHS = Object.freeze([
  /^\/api\/files$/, // POST records an upload (GET is the listing)
  /^\/api\/files\/presign$/, // a PUT for a new file, or for new contents (replaceOf)
  /^\/api\/files\/upload\/multipart$/, // resumable upload, all its actions
  /^\/api\/files\/folders$/, // create, rename or move, delete, list
  new RegExp(`^/api/files/(?!${SIBLINGS}$)[^/]+$`), // one file: read, rename or move, trash
  new RegExp(`^/api/files/(?!${SIBLINGS}$)[^/]+/content$`), // swap in new contents
  new RegExp(`^/api/files/(?!${SIBLINGS}$)[^/]+/thumbnail$`), // a thumbnail made on the Mac: whether it may, then record it
  new RegExp(`^/api/files/(?!${SIBLINGS}$)[^/]+/waveform$`), // a sound's waveform made on the Mac, likewise
  // Links, from the iPhone's Share Link sheet: a file's (list, make; change
  // what one lets people do, revoke) and a folder's (list, make; revoke).
  new RegExp(`^/api/files/${FILE_ID}/shares$`),
  new RegExp(`^/api/files/${FILE_ID}/shares/[^/]+$`),
  /^\/api\/files\/folders\/shares$/,
  /^\/api\/files\/folders\/shares\/[^/]+$/,
  /^\/api\/admin\/trash\/restore$/, // put trashed files back — admins only, as on the web
]);

/**
 * The token in an Authorization header, or null. `Bearer <token>`, the scheme
 * in any case — the parse lib/desktop-guard.js has always made, kept in one
 * place so the gate and the check can never disagree about what a bearer is.
 */
export function bearerToken(header) {
  const m = /^Bearer\s+(.+)$/i.exec(String(header || '').trim());
  return m?.[1]?.trim() || null;
}

/** Does this request go past the sign-in gate to a handler that checks its token? */
export function bearerMayPass(pathname, authorization) {
  if (!bearerToken(authorization)) return false;
  const path = String(pathname || '');
  return BEARER_PATHS.some((re) => re.test(path));
}
