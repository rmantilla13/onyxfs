// OAuth for MCP clients (lib/oauth.js): the metadata a client discovers, who
// may register and be sent back where, and what an authorization request
// must carry before anyone is asked to allow it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizationServerMetadata, protectedResourceMetadata, challengeHeader, redirectProblem,
  validateRegistration, checkAuthorize, withQuery,
} from '../lib/oauth.js';

const O = 'https://onyx.test';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const client = { id: 'onyx_abc', name: 'Claude', redirectUris: ['https://claude.ai/api/mcp/auth_callback'] };
const ok = (over = {}) => ({
  response_type: 'code', client_id: client.id, redirect_uri: client.redirectUris[0],
  code_challenge: CHALLENGE, code_challenge_method: 'S256', state: 's1', ...over,
});

describe('discovery', () => {
  test('the resource names its server; the server names its endpoints and PKCE', () => {
    const r = protectedResourceMetadata(O);
    assert.equal(r.resource, `${O}/api/mcp`);
    assert.deepEqual(r.authorization_servers, [O]);
    const s = authorizationServerMetadata(O);
    assert.equal(s.issuer, O);
    assert.equal(s.authorization_endpoint, `${O}/oauth/authorize`);
    assert.equal(s.token_endpoint, `${O}/api/oauth/token`);
    assert.equal(s.registration_endpoint, `${O}/api/oauth/register`);
    assert.deepEqual(s.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(s.token_endpoint_auth_methods_supported, ['none']);
  });

  test('a 401 points at the resource metadata', () => {
    assert.equal(challengeHeader(O), `Bearer resource_metadata="${O}/.well-known/oauth-protected-resource"`);
    assert.match(challengeHeader(O, { error: 'invalid_token' }), /, error="invalid_token"$/);
  });
});

describe('registration', () => {
  test('https anywhere, http only on this computer, never a fragment', () => {
    assert.equal(redirectProblem('https://claude.ai/cb'), null);
    assert.equal(redirectProblem('http://localhost:6274/cb'), null);
    assert.equal(redirectProblem('http://127.0.0.1/cb'), null);
    assert.ok(redirectProblem('http://evil.example/cb'));
    assert.ok(redirectProblem('https://claude.ai/cb#x'));
    assert.ok(redirectProblem('javascript:alert(1)'));
    assert.ok(redirectProblem('not a url'));
  });

  test('a public client with its addresses; a confidential one or a bad address is refused', () => {
    const v = validateRegistration({ client_name: 'Claude\u0007', redirect_uris: ['https://claude.ai/cb', 'https://claude.ai/cb'] });
    assert.deepEqual(v.value, { name: 'Claude', redirectUris: ['https://claude.ai/cb'] });
    assert.ok(validateRegistration({ redirect_uris: [] }).error);
    assert.ok(validateRegistration({ redirect_uris: ['http://evil.example/cb'] }).error);
    assert.ok(validateRegistration({ redirect_uris: ['https://a/cb'], token_endpoint_auth_method: 'client_secret_basic' }).error);
    assert.ok(validateRegistration({ redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a/${i}`) }).error);
    assert.ok(validateRegistration(null).error);
    assert.equal(validateRegistration({ redirect_uris: ['https://a/cb'] }).value.name, 'An MCP client');
  });
});

describe('authorization requests', () => {
  test('a good one: what the code needs', () => {
    assert.deepEqual(checkAuthorize(ok(), client).value, {
      clientId: client.id, clientName: 'Claude', redirectUri: client.redirectUris[0], state: 's1', challenge: CHALLENGE,
    });
  });

  test('an unknown client or an unregistered address is shown here, never redirected to', () => {
    assert.equal(checkAuthorize(ok(), null).redirect, false);
    const r = checkAuthorize(ok({ redirect_uri: 'https://evil.example/cb' }), client);
    assert.equal(r.redirect, false);
    assert.equal(r.redirectUri, undefined);
  });

  test('a single registered address may be left out', () => {
    assert.equal(checkAuthorize(ok({ redirect_uri: undefined }), client).value.redirectUri, client.redirectUris[0]);
  });

  test('no PKCE, plain PKCE or another response type goes back to the client as an error', () => {
    for (const p of [ok({ code_challenge: undefined }), ok({ code_challenge_method: 'plain' }), ok({ code_challenge: 'short' })]) {
      const r = checkAuthorize(p, client);
      assert.equal(r.error, 'invalid_request');
      assert.equal(r.redirect, true);
      assert.equal(r.state, 's1');
    }
    assert.equal(checkAuthorize(ok({ response_type: 'token' }), client).error, 'unsupported_response_type');
  });

  test('withQuery keeps what the address had', () => {
    assert.equal(withQuery('https://a/cb?x=1', { code: 'c', state: 's', no: null }), 'https://a/cb?x=1&code=c&state=s');
  });
});
