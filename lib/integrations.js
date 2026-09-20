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
