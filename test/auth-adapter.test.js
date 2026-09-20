// Tests for the Auth.js adapter's shape.
//
// Regression test for a real production failure: the adapter was a Proxy that
// only trapped `get`. Every method read back as a function, so it looked
// correct under every obvious check — but Auth.js validates an adapter by
// asking whether the methods are PRESENT, and `'createVerificationToken' in
// proxy` falls through to the proxy's target object and answers false.
//
// Sign-in failed at runtime with MissingAdapterMethods while the build passed
// and nothing locally complained. So these tests deliberately assert presence
// the way Auth.js does — `in` and key enumeration — not the way that felt
// natural and missed it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// The methods Auth.js requires for an email/magic-link provider. These three
// are exactly what the production error named.
const EMAIL_PROVIDER_METHODS = ['createVerificationToken', 'useVerificationToken', 'getUserByEmail'];

const CORE_METHODS = [
  'createUser', 'getUser', 'getUserByAccount', 'updateUser',
  'linkAccount', 'createSession', 'getSessionAndUser', 'updateSession', 'deleteSession',
];

/**
 * Import auth.js with no DATABASE_URL, which is the build-time path and the
 * only one reachable without a live database. It must still satisfy Auth.js's
 * validation — a build that cannot construct a valid-looking adapter fails
 * page-data collection.
 */
async function loadAdapter() {
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  const { isDbConfigured } = await import('../lib/db.js');
  assert.equal(isDbConfigured(), false, 'test needs an unconfigured database');

  // The real module auth.js uses — not a copy. A regression test against a
  // reimplementation of the logic would not have caught the original bug.
  const { ADAPTER_METHODS, unconfiguredAdapter } = await import('../lib/auth-adapter.js');
  return { adapter: unconfiguredAdapter(), ADAPTER_METHODS };
}

describe('Auth.js adapter shape', () => {
  test('required methods are present under the `in` operator', async () => {
    // THE regression. A get-only Proxy passes every other check and fails this.
    const { adapter } = await loadAdapter();
    for (const m of [...EMAIL_PROVIDER_METHODS, ...CORE_METHODS]) {
      assert.ok(m in adapter, `'${m}' in adapter === false — Auth.js reports this as missing`);
    }
  });

  test('required methods appear in Object.keys', async () => {
    const { adapter } = await loadAdapter();
    const keys = new Set(Object.keys(adapter));
    for (const m of EMAIL_PROVIDER_METHODS) {
      assert.ok(keys.has(m), `'${m}' is not an own enumerable key`);
    }
  });

  test('required methods are callable functions', async () => {
    const { adapter } = await loadAdapter();
    for (const m of EMAIL_PROVIDER_METHODS) {
      assert.equal(typeof adapter[m], 'function', `${m} is not a function`);
    }
  });

  test('the unconfigured stub throws a message that says what to fix', async () => {
    // It must look complete to Auth.js but never silently succeed — a stub
    // that resolved would make sign-in appear to work and issue nothing.
    const { adapter } = await loadAdapter();
    await assert.rejects(
      () => adapter.createVerificationToken({}),
      /DATABASE_URL/,
      'the stub should name the missing configuration'
    );
  });

  test('the method list covers everything an email provider needs', async () => {
    const { ADAPTER_METHODS } = await loadAdapter();
    for (const m of EMAIL_PROVIDER_METHODS) {
      assert.ok(ADAPTER_METHODS.includes(m), `ADAPTER_METHODS is missing ${m}`);
    }
  });
});
