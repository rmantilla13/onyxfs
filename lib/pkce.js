/**
 * PKCE S256: challenge = base64url(sha256(verifier)), no padding. Web Crypto
 * rather than node:crypto so it matches the native clients byte-for-byte —
 * OnyxKit's PKCETests are pinned to this function's output.
 */
export async function pkceChallenge(verifier) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(verifier)));
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * What /space/authorize was opened with. The Tauri app sends `code_challenge`;
 * the Mac app sends `challenge` — reading only the first left the Mac's
 * "Sign in with your browser" on a page with nothing to authorize. `label` is
 * the device naming itself, shown on the consent screen and kept on the code.
 */
export function authorizeParams(searchParams = {}) {
  const one = (v) => String((Array.isArray(v) ? v[0] : v) || '');
  return {
    challenge: one(searchParams.code_challenge) || one(searchParams.challenge),
    state: one(searchParams.state),
    label: one(searchParams.label).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80),
  };
}
