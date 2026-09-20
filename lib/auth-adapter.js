// lib/auth-adapter.js — the shape of the Auth.js adapter.
//
// Split out of auth.js so it can be tested. auth.js imports next-auth and uses
// the '@/…' alias, neither of which resolves outside Next's bundler, so
// anything that needs a test has to live somewhere plainer.
//
// WHAT WENT WRONG HERE ONCE
//
// This was a Proxy that only trapped `get`. Every method read back as a
// function, so `typeof adapter.createVerificationToken === 'function'` was
// true and nothing looked wrong. But Auth.js validates an adapter by asking
// whether the methods its providers need are PRESENT — an `in` / enumeration
// check — and `'createVerificationToken' in proxy` falls through to the
// proxy's target, which was `{}`.
//
// The build passed. Sign-in failed in production with MissingAdapterMethods.
//
// So: a real object with real own-properties, never a Proxy.

/**
 * Every method Auth.js may look for. Used only for the unconfigured stub — a
 * configured adapter is enumerated from the real one, so a method added by a
 * future adapter version is carried through rather than silently dropped.
 */
export const ADAPTER_METHODS = [
  'createUser', 'getUser', 'getUserByEmail', 'getUserByAccount', 'updateUser', 'deleteUser',
  'linkAccount', 'unlinkAccount',
  'createSession', 'getSessionAndUser', 'updateSession', 'deleteSession',
  'createVerificationToken', 'useVerificationToken',
];

/**
 * A stand-in for when there is no database configured — during `next build`,
 * before env vars exist. It must look complete to Auth.js's validation, so the
 * build can collect page data, while never silently succeeding: a stub that
 * resolved would make sign-in appear to work and issue nothing.
 *
 * Constructing the real adapter here is not an option: drizzle-orm/postgres-js
 * inspects its client at construction and throws on the placeholder that
 * stands in for a missing connection string.
 */
export function unconfiguredAdapter() {
  const stub = {};
  for (const name of ADAPTER_METHODS) {
    stub[name] = async () => {
      throw new Error('Database is not configured — set DATABASE_URL and redeploy. See /api/health.');
    };
  }
  return stub;
}

/**
 * Wrap a real adapter so `ensure()` runs before each method.
 *
 * Onyx creates every table lazily and the adapter is the one consumer that
 * reaches the database before any of our own code does, so there is no natural
 * call site to hang the guard on. After the first call `ensure()` returns a
 * settled promise, making the steady-state cost a microtask.
 *
 * Returns a plain object with own enumerable properties — see the note at the
 * top for why that matters.
 */
export function wrapAdapter(base, ensure) {
  const wrapped = {};
  for (const name of Object.keys(base)) {
    const value = base[name];
    wrapped[name] = typeof value !== 'function' ? value : async (...args) => {
      await ensure();
      return value.apply(base, args);
    };
  }
  return wrapped;
}
