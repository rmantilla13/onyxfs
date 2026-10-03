// lib/oauth.js — OAuth 2.1 for MCP clients (Claude), as the MCP authorization
// spec asks of a remote server: /api/mcp is a protected resource, and Onyx
// is its own authorization server.
//
//   GET  /.well-known/oauth-protected-resource      which server issues tokens
//   GET  /.well-known/oauth-authorization-server    its endpoints
//   POST /api/oauth/register                        a client registers itself (RFC 7591)
//   GET  /oauth/authorize                           the person signs in and allows it
//   POST /api/oauth/authorize                       … which mints a code (PKCE S256)
//   POST /api/oauth/token                           the code becomes a token
//
// The token is a device token (desktop_tokens), as Onyx for Mac's and the
// iPhone's are: the person sees "Claude" among their devices on the web and
// can sign it out there, and every tool goes through the same routes, with
// the same rules, as the web (lib/mcp/tools.js). Nothing here grants more
// than the person signing in has.
//
// Pure and dependency-free: the routes and the tests read one definition.

export const SCOPE = 'onyx';
export const ACCESS_TOKEN_TTL_S = 90 * 24 * 60 * 60;
const MAX_REDIRECTS = 10;
const MAX_NAME = 80;

/** Where the token endpoint and the rest live, for `origin` (no trailing slash). */
export function authorizationServerMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
  };
}

/** The MCP endpoint as an OAuth protected resource (RFC 9728). */
export function protectedResourceMetadata(origin) {
  return {
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Onyx',
  };
}

/** What /api/mcp answers a request without a usable token: where to find out how to get one. */
export function challengeHeader(origin, { error = null } = {}) {
  const parts = [`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`];
  if (error) parts.push(`error="${error}"`);
  return parts.join(', ');
}

/**
 * Whether a client may be sent back to `uri`: https anywhere, or http only on
 * this computer (a desktop client listening locally), never with a fragment.
 */
export function redirectProblem(uri) {
  let u;
  try { u = new URL(String(uri)); } catch { return 'is not a URL'; }
  if (u.hash) return 'may not have a fragment';
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return null;
  return 'must be https (or http on localhost)';
}

/** A registration request (RFC 7591), checked. Resolves { value: { name, redirectUris } } or { error }. */
export function validateRegistration(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send the registration as a JSON object.' };
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || !uris.length) return { error: 'redirect_uris must list at least one address.' };
  if (uris.length > MAX_REDIRECTS) return { error: `At most ${MAX_REDIRECTS} redirect_uris.` };
  for (const u of uris) {
    const problem = typeof u === 'string' ? redirectProblem(u) : 'is not a string';
    if (problem) return { error: `redirect_uri ${problem}.` };
  }
  const method = body.token_endpoint_auth_method ?? 'none';
  if (method !== 'none') return { error: 'Only public clients (token_endpoint_auth_method "none") may register.' };
  // eslint-disable-next-line no-control-regex
  const name = String(body.client_name || 'An MCP client').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME) || 'An MCP client';
  return { value: { name, redirectUris: [...new Set(uris)] } };
}

/**
 * An authorization request (the /oauth/authorize query), checked against the
 * client that registered. Resolves { value } with what a code needs, or
 * { error, redirect } — redirect false when the client or its redirect_uri
 * cannot be trusted, so the error is shown here rather than sent anywhere.
 */
export function checkAuthorize(params, client) {
  const one = (k) => {
    const v = params?.[k];
    return String((Array.isArray(v) ? v[0] : v) ?? '');
  };
  if (!client) return { error: 'This app is not registered with Onyx. Add the connector again.', redirect: false };
  const redirectUri = one('redirect_uri') || (client.redirectUris.length === 1 ? client.redirectUris[0] : '');
  if (!client.redirectUris.includes(redirectUri)) return { error: 'This app asked to be sent somewhere it did not register.', redirect: false };
  const state = one('state');
  if (one('response_type') !== 'code') return { error: 'unsupported_response_type', redirect: true, redirectUri, state };
  const challenge = one('code_challenge');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || one('code_challenge_method') !== 'S256') {
    return { error: 'invalid_request', description: 'PKCE with S256 is required.', redirect: true, redirectUri, state };
  }
  return { value: { clientId: client.id, clientName: client.name, redirectUri, state, challenge } };
}

/** `redirectUri` with `query` added, as a client expects its answer. */
export function withQuery(redirectUri, query) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(query)) if (v != null && v !== '') u.searchParams.set(k, String(v));
  return u.toString();
}
