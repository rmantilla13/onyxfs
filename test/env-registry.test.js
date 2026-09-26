// The environment variables, and the three lists that used to disagree.
//
// `.env.local.example`, lib/integrations.js and scripts/doctor.mjs each named
// a different set. The example file told you to set four NEXT_PUBLIC_*
// mirrors that nothing read; the doctor never mentioned AUTH_TRUST_HOST,
// which next-auth consumes internally and which therefore appears in no
// `process.env` grep — making it the single easiest variable to miss and the
// one whose absence produces the most opaque failure.
//
// The tests that matter here are the two that cannot be fixed by reading
// carefully: that no admin or allowlist value is exposed to the browser, and
// that the registry stays the only list.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const {
  ENV_VARS, ENV_VARS_RETIRED, envVarKeys, envRegistryGaps, INTEGRATIONS,
} = await import('../lib/integrations.js');

const ROOT = new URL('..', import.meta.url).pathname;

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === 'node_modules' || name === '.next' || name === '.git') continue;
    const rel = join(dir, name);
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) sourceFiles(rel, out);
    else if (/\.(js|mjs)$/.test(name)) out.push(rel);
  }
  return out;
}

const SOURCES = [
  ...sourceFiles('app'), ...sourceFiles('lib'), ...sourceFiles('scripts'),
  'middleware.js', 'auth.js', 'auth.config.js', 'next.config.js',
].filter((f) => { try { statSync(join(ROOT, f)); return true; } catch { return false; } });

/**
 * Strip comments before scanning for `process.env.X`.
 *
 * Without this the scan trips over prose: lib/config.js's header explains
 * itself by writing `process.env.X`, and a test that reads documentation as
 * code fails for a reason nobody can act on. The `[^:]` guard on the line
 * comment is what stops `https://` being treated as one.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const readAll = () => SOURCES.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]);
const readAllCode = () => readAll().map(([f, t]) => [f, stripComments(t)]);

describe('no admin or allowlist value reaches the browser', () => {
  // THE security property. NEXT_PUBLIC_* is inlined into the client bundle at
  // build time, so reading one of these anywhere ships the workspace's admin
  // roster to every visitor. The four that existed did not even do anything
  // in exchange: they were read behind an `isClient` flag nothing passed.
  const FORBIDDEN = [
    'NEXT_PUBLIC_ADMIN_EMAILS',
    'NEXT_PUBLIC_SUPER_ADMIN_EMAILS',
    'NEXT_PUBLIC_ALLOWED_EMAILS',
    'NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN',
  ];

  test('none of them is read in any source file', () => {
    for (const [file, text] of readAllCode()) {
      for (const key of FORBIDDEN) {
        assert.ok(
          !text.includes(`process.env.${key}`),
          `${file} reads ${key} — that inlines the admin list into the client bundle`,
        );
      }
    }
  });

  test('the example file does not tell anyone to set them', () => {
    // A commented-out line is still an instruction; an assignment is what
    // counts. Prose explaining why they are gone is fine.
    const text = readFileSync(join(ROOT, '.env.local.example'), 'utf8');
    for (const key of FORBIDDEN) {
      assert.ok(
        !new RegExp(`^\\s*#?\\s*${key}\\s*=`, 'm').test(text),
        `.env.local.example still assigns ${key}`,
      );
    }
  });

  test('each is recorded as retired, so the doctor can warn about a stale one', () => {
    const retired = new Set(ENV_VARS_RETIRED.map((v) => v.key));
    for (const key of FORBIDDEN) assert.ok(retired.has(key), `${key} is not listed as retired`);
  });

  test('the live NEXT_PUBLIC_ variables carry nothing sensitive', () => {
    // Two remain and both are fine: an origin and a boolean.
    const live = envVarKeys().filter((k) => k.startsWith('NEXT_PUBLIC_'));
    assert.deepEqual(live.sort(), ['NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_OKTA_ENABLED']);
  });
});

describe('the registry is the only list', () => {
  test('every env var an integration names is in ENV_VARS', () => {
    // envRegistryGaps is the guard; this asserts it finds nothing today.
    assert.deepEqual(envRegistryGaps(), []);
  });

  test('every variable the code actually reads is registered', () => {
    // The direction that catches a NEW variable someone adds without
    // documenting it — the way the three lists drifted apart originally.
    const known = new Set([
      ...envVarKeys(),
      ...ENV_VARS_RETIRED.map((v) => v.key),
      // Build/runtime vars supplied by the platform, not by a human.
      'NODE_ENV', 'VERCEL_ENV', 'VERCEL_GIT_COMMIT_SHA', 'VERCEL_GIT_COMMIT_REF',
      'VERCEL_GIT_COMMIT_MESSAGE',
      // Test-only.
      'TEST_DATABASE_URL', 'TEST_S3_ENDPOINT',
      // Tooling: `npm run schema:sql` (scripts/gen-init-sql.mjs). Set by a
      // developer for one command, never on a deployment.
      'SCHEMA_SQL_SERVER_URL', 'ONYX_SCHEMA_CAPTURE',
    ]);
    const missing = new Map();
    for (const [file, text] of readAllCode()) {
      for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
        if (!known.has(m[1])) missing.set(m[1], file);
      }
    }
    assert.deepEqual(
      [...missing.entries()],
      [],
      'unregistered env vars — add them to ENV_VARS in lib/integrations.js',
    );
  });

  test('variables consumed by a library are registered even though no grep finds them', () => {
    // AUTH_TRUST_HOST is the reason this test exists: next-auth reads it, no
    // Onyx line mentions it, and without it sign-in fails opaquely behind
    // Vercel's proxy. A list built by grepping would omit exactly this one.
    const byKey = new Map(ENV_VARS.map((v) => [v.key, v]));
    assert.ok(byKey.has('AUTH_TRUST_HOST'));
    assert.equal(byKey.get('AUTH_TRUST_HOST').requirement, 'required');
    assert.equal(byKey.get('AUTH_TRUST_HOST').consumedBy, 'next-auth');
  });
});

describe('ENV_VARS is well formed', () => {
  test('no duplicate keys', () => {
    const keys = envVarKeys();
    assert.equal(new Set(keys).size, keys.length);
  });

  test('every entry has a requirement the doctor understands', () => {
    for (const v of ENV_VARS) {
      assert.ok(['required', 'recommended', 'optional'].includes(v.requirement), `${v.key}: ${v.requirement}`);
    }
  });

  test('every entry explains itself', () => {
    for (const v of ENV_VARS) {
      assert.ok(v.why && v.why.length > 20, `${v.key} needs a reason someone can act on`);
    }
  });

  test('the four required ones are exactly what a new deploy needs', () => {
    const required = ENV_VARS.filter((v) => v.requirement === 'required').map((v) => v.key).sort();
    assert.deepEqual(required, ['AUTH_SECRET', 'AUTH_TRUST_HOST', 'DATABASE_URL', 'RESEND_API_KEY']);
  });

  test('DATABASE_URL records POSTGRES_URL as its alternative', () => {
    // lib/db.js is `DATABASE_URL || POSTGRES_URL`. Recording the fallback is
    // what lets the doctor check the pair rather than each in isolation.
    const dbUrl = ENV_VARS.find((v) => v.key === 'DATABASE_URL');
    assert.equal(dbUrl.alternative, 'POSTGRES_URL');
    assert.match(dbUrl.why, /6543/, 'the port is the thing people get wrong');
  });
});

describe('INTEGRATIONS still backs the admin panel', () => {
  test('the required integrations are unchanged', () => {
    const required = INTEGRATIONS.filter((i) => i.status === 'required').map((i) => i.key).sort();
    assert.deepEqual(required, ['auth', 'postgres', 'resend', 's3']);
  });

  test('no integration exposes a secret value', () => {
    // integrationStatus reports presence only; this pins that the registry
    // itself never carries a value to leak.
    for (const i of INTEGRATIONS) {
      for (const v of i.envVars) assert.equal(typeof v, 'string');
      assert.ok(!('values' in i));
    }
  });
});
