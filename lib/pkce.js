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
