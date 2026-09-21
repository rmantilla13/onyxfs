/**
 * Central registry of every third-party service Onyx touches.
 *
 * Single source of truth for:
 *   - which env vars each capability needs
 *   - what each service unlocks when configured
 *   - the setup steps to hand to whoever owns the account
 *
 * The admin Integrations tab renders this list, and lib/config.js derives its
 * set of admin-editable keys from the `envVars` below — so registering a
 * service here is what makes its key settable from the admin panel.
 *
 * Nothing here exposes a secret VALUE. Status is presence/absence only.
 */

/**
 * Every environment variable Onyx reads, in one place.
 *
 * This list exists because there were three of them and they disagreed.
 * `.env.local.example`, the INTEGRATIONS registry below and
 * `scripts/doctor.mjs` each named a different set: the example file told you
 * to set four NEXT_PUBLIC_* mirrors that nothing read, the doctor omitted
 * AUTH_TRUST_HOST (which next-auth consumes internally, so it appears in no
 * `process.env` grep and is therefore the easiest one to miss), and neither
 * mentioned SUPER_ADMIN_EMAILS, ALLOWED_EMAILS or SLACK_WEBHOOK_URL.
 *
 * `scripts/doctor.mjs` now reads this array instead of keeping its own copy,
 * so the two cannot drift apart again. `requirement` is:
 *
 *   required     the app does not function without it
 *   recommended  it runs, but something visible is wrong or unsafe
 *   optional     switches a feature on
 *
 * `consumedBy` matters for anything a grep cannot find: 'next-auth' means the
 * library reads it and no Onyx source line mentions it.
 */
export const ENV_VARS = [
  {
    key: 'DATABASE_URL',
    requirement: 'required',
    why: 'Postgres connection. Must be the Supabase TRANSACTION pooler — host …pooler.supabase.com, port 6543. The direct connection opens a real socket per serverless invocation and exhausts the limit. POSTGRES_URL is a valid fallback source (lib/db.js prefers DATABASE_URL and falls back to it), so a deployment may be running on POSTGRES_URL alone: confirm DATABASE_URL holds a working string BEFORE removing it.',
    alternative: 'POSTGRES_URL',
  },
  {
    key: 'AUTH_SECRET',
    requirement: 'required',
    why: 'Session signing. Generate with: openssl rand -base64 32',
  },
  {
    key: 'AUTH_TRUST_HOST',
    requirement: 'required',
    why: 'Set to "true". Without it Auth.js rejects the host Vercel proxies through, and sign-in fails with an opaque configuration error.',
    consumedBy: 'next-auth',
  },
  {
    key: 'RESEND_API_KEY',
    requirement: 'required',
    why: 'Sends the magic-link email. Without it nobody can sign in at all.',
  },
  {
    key: 'NOTIFY_FROM',
    requirement: 'recommended',
    why: 'Sender for the sign-in email, e.g. "Onyx <noreply@onyxfs.io>". Falls back to onboarding@resend.dev, an unverified shared domain that lands in spam.',
  },
  {
    key: 'NEXT_PUBLIC_APP_URL',
    requirement: 'recommended',
    why: 'This deployment\'s origin. Backs share-link URLs and the magic-link email; absent, share URLs come out relative.',
  },
  {
    key: 'CRON_SECRET',
    requirement: 'recommended',
    why: 'Authorizes /api/cron/maintenance, and is the only way into /api/health when sign-in itself is broken — which is when you need it most.',
  },
  {
    key: 'ADMIN_EMAILS',
    requirement: 'recommended',
    why: 'Comma-separated admins. Unset, the only admin is the bootstrap address compiled into lib/auth-allowlist.js.',
  },
  {
    key: 'SUPER_ADMIN_EMAILS',
    requirement: 'optional',
    why: 'Stricter subset of admins, for brand, storage and the secret-override panel. Same bootstrap fallback as ADMIN_EMAILS.',
  },
  {
    key: 'ALLOWED_EMAIL_DOMAIN',
    requirement: 'optional',
    why: 'Comma-separated domains that may request access. Unset means invite-only, which is the intended default.',
  },
  {
    key: 'ALLOWED_EMAILS',
    requirement: 'optional',
    why: 'Individual addresses allowed outside any listed domain.',
  },
  {
    key: 'SLACK_WEBHOOK_URL',
    requirement: 'optional',
    why: 'Posts access requests and usage-rights expiry warnings to a channel.',
  },
  {
    key: 'NEXT_PUBLIC_OKTA_ENABLED',
    requirement: 'optional',
    why: 'Set to "true" to show the Okta button on the sign-in page. Only useful alongside the three AUTH_OKTA_* vars.',
  },
  {
    key: 'AUTH_OKTA_ID',
    requirement: 'optional',
    why: 'Okta SSO. All three AUTH_OKTA_* vars must be present or the provider is not registered at all.',
  },
  { key: 'AUTH_OKTA_SECRET', requirement: 'optional', why: 'Okta SSO — see AUTH_OKTA_ID.' },
  { key: 'AUTH_OKTA_ISSUER', requirement: 'optional', why: 'Okta SSO — see AUTH_OKTA_ID.' },
  {
    key: 'BLOB_READ_WRITE_TOKEN',
    requirement: 'optional',
    why: 'Vercel Blob fallback store, injected automatically by the Vercel integration. Unnecessary once an S3-compatible bucket is configured in Admin → Storage.',
    consumedBy: '@vercel/blob',
  },
  {
    key: 'SCHEMA_MANAGED',
    requirement: 'optional',
    why: 'Leave unset. It already defaults to on in production, which keeps DDL off the request path; setting it to 0 puts it back and risks the lock convoy that caused an outage.',
  },
];

/**
 * Variables a reasonable person would set because something told them to, and
 * that do nothing. Kept by name so the doctor can say so out loud rather than
 * staying silent about a setting that looks load-bearing.
 */
export const ENV_VARS_RETIRED = [
  {
    key: 'NEXT_PUBLIC_ADMIN_EMAILS',
    why: 'Read only through an `isClient` parameter that nothing passes; every importer of lib/auth-allowlist.js is server-side. It has no effect, and it would publish the admin list into the browser bundle.',
  },
  { key: 'NEXT_PUBLIC_SUPER_ADMIN_EMAILS', why: 'Same as NEXT_PUBLIC_ADMIN_EMAILS — no effect, and it leaks the list.' },
  { key: 'NEXT_PUBLIC_ALLOWED_EMAILS', why: 'Same dead client path. Use ALLOWED_EMAILS.' },
  { key: 'NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN', why: 'Same dead client path. Use ALLOWED_EMAIL_DOMAIN.' },
];

/** Every key in ENV_VARS, including declared alternatives. */
export function envVarKeys() {
  return ENV_VARS.flatMap((v) => (v.alternative ? [v.key, v.alternative] : [v.key]));
}

/**
 * Guard against the drift this registry exists to end: every env var named by
 * an INTEGRATIONS entry must also appear here. Called by a test, not at
 * runtime — a registry mismatch should fail the build, not a request.
 */
export function envRegistryGaps() {
  const known = new Set(envVarKeys());
  const gaps = [];
  for (const i of INTEGRATIONS) {
    for (const key of i.envVars) {
      if (!known.has(key)) gaps.push({ integration: i.key, key });
    }
  }
  return gaps;
}

export const INTEGRATIONS = [
  {
    key: 'postgres',
    name: 'Postgres (Supabase)',
    category: 'Core',
    status: 'required',
    description:
      'Every table in Onyx: the file catalog, folders, filespaces and grants, share links, invites, desktop tokens, and the settings blob that backs all runtime config.',
    envVars: ['DATABASE_URL'],
    unlocks: ['Everything'],
    docsUrl: 'https://supabase.com/docs/guides/database',
    setupSteps: [
      'Create a Supabase project. Only the Postgres database is used — Onyx brings its own auth and talks to S3 directly.',
      'Copy the CONNECTION POOLER string (port 6543, transaction mode) into DATABASE_URL — not the direct connection, which exhausts the connection limit on serverless.',
      'No migration step: every table is created lazily on first use. Run `npm run doctor` to create them and verify.',
      'For Phase 2 semantic search, enable the pgvector extension under Database → Extensions.',
    ],
  },
  {
    key: 'auth',
    name: 'Auth.js',
    category: 'Core',
    status: 'required',
    description: 'Session signing and the magic-link flow.',
    envVars: ['AUTH_SECRET', 'AUTH_TRUST_HOST'],
    unlocks: ['Sign-in'],
    docsUrl: 'https://authjs.dev',
    setupSteps: [
      'Generate a secret: openssl rand -base64 32 → AUTH_SECRET.',
      'Set AUTH_TRUST_HOST=true on Vercel.',
    ],
  },
  {
    key: 'resend',
    name: 'Resend (transactional email)',
    category: 'Core',
    status: 'required',
    description:
      'Sends the magic-link sign-in email. Without it nobody can sign in, so it is required even though Onyx sends no other mail.',
    envVars: ['RESEND_API_KEY', 'NOTIFY_FROM'],
    unlocks: ['Magic-link sign-in', 'Access-request notifications'],
    docsUrl: 'https://resend.com/docs',
    setupSteps: [
      'Create an API key at resend.com → API Keys.',
      'Verify your sending domain, then set NOTIFY_FROM, e.g. "Onyx <noreply@onyxfs.io>".',
      'Before the domain verifies you can use "Onyx <onboarding@resend.dev>" to test.',
    ],
  },
  {
    key: 's3',
    name: 'AWS S3 (or any S3-compatible bucket)',
    category: 'Storage',
    status: 'required',
    description:
      'Where the bytes live. Configured in Admin → Storage rather than env vars, because the credentials are per-deployment and the admin panel can test them. Works with AWS S3, Cloudflare R2, DigitalOcean Spaces, Backblaze B2, Wasabi, and MinIO.',
    envVars: [],
    unlocks: ['File storage', 'Filespaces', 'Desktop mounts', 'Presigned upload + download'],
    docsUrl: 'https://docs.aws.amazon.com/s3/',
    setupSteps: [
      'Create a bucket and an IAM user with s3:GetObject, s3:PutObject, s3:DeleteObject and s3:ListBucket on it.',
      'For scoped desktop credentials, also allow sts:GetFederationToken on the key — or create a role and set its ARN.',
      'Enter the bucket, region and keys in Admin → Storage, then use "Test connection".',
      'Apply the CORS policy from Admin → Storage so browser uploads work.',
    ],
  },
  {
    key: 'blob',
    name: 'Vercel Blob',
    category: 'Storage',
    status: 'optional',
    description:
      'Fallback object store, used automatically when no S3 bucket is configured. Fine for evaluating Onyx, but it cannot be mounted — filespaces and the desktop app need S3.',
    envVars: ['BLOB_READ_WRITE_TOKEN'],
    unlocks: ['File storage without an S3 bucket'],
    docsUrl: 'https://vercel.com/docs/storage/vercel-blob',
    setupSteps: ['Vercel project → Storage → Create → Blob. The token is injected automatically.'],
  },
  {
    key: 'slack',
    name: 'Slack',
    category: 'Notifications',
    status: 'optional',
    description: 'Posts access requests and usage-rights expiry warnings to a channel.',
    envVars: ['SLACK_WEBHOOK_URL'],
    unlocks: ['Slack notifications'],
    docsUrl: 'https://api.slack.com/messaging/webhooks',
    setupSteps: ['Create an incoming webhook for the target channel and paste the URL.'],
  },
  {
    key: 'okta',
    name: 'Okta SSO',
    category: 'Access',
    status: 'optional',
    description:
      'Adds an SSO button to the sign-in page. Registered only when all three vars are present. Okta establishes WHO is signing in; the Onyx allowlist still decides whether they are allowed — so neither one alone grants access.',
    envVars: ['AUTH_OKTA_ID', 'AUTH_OKTA_SECRET', 'AUTH_OKTA_ISSUER'],
    unlocks: ['SSO sign-in'],
    docsUrl: 'https://authjs.dev/getting-started/providers/okta',
    setupSteps: [
      'Create an OIDC web application in Okta.',
      'Set the redirect URI to https://<your-domain>/api/auth/callback/okta.',
      'Set all three env vars, then redeploy.',
    ],
  },
];

/** Presence-only status for one integration. Never returns a secret value. */
export function integrationStatus(key) {
  const i = INTEGRATIONS.find((x) => x.key === key);
  if (!i) return null;
  const vars = i.envVars.map((v) => ({ key: v, set: !!process.env[v] }));
  const configured = i.envVars.length === 0 ? null : vars.every((v) => v.set);
  return { key: i.key, name: i.name, status: i.status, configured, vars };
}

export function allIntegrationStatuses() {
  return INTEGRATIONS.map((i) => integrationStatus(i.key));
}

export default INTEGRATIONS;
