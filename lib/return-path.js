// lib/return-path.js — where to send someone after they sign in.

/**
 * A same-site path from a ?callbackUrl= (or the form field carrying one), or
 * null. The middleware hands over a full URL; a link might hand over a path.
 * Either way only the path, query and hash survive — never a host — so this
 * cannot be turned into a redirect to another site. "//evil.example" and
 * "/\evil.example" are read by browsers as another origin and are refused.
 */
export function safeReturnPath(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      return `${u.pathname}${u.search}${u.hash}` || '/';
    } catch {
      return null;
    }
  }
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) return null;
  return v;
}
