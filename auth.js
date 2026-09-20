import NextAuth from 'next-auth';
import Resend from 'next-auth/providers/resend';
import Okta from 'next-auth/providers/okta';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { Resend as ResendClient } from 'resend';
import { getDb, ensureAuthTables, createMagicLinkRedirect } from '@/lib/db';
import { isEmailGrantedAccess } from '@/lib/auth-allowlist';
import { loadBrand } from '@/lib/brand-config';
import { signInEmail } from '@/lib/signin-email';
import { authConfig } from '@/auth.config';

/**
 * The Auth.js adapter, built on first use rather than at module load, with
 * every method wrapped so the Auth.js tables are created before it runs.
 *
 * Two deferrals in one place, for two different reasons:
 *
 *   - The adapter itself is constructed lazily because building it requires a
 *     live database handle, and this module is imported during the build and
 *     anywhere DATABASE_URL might be unset. Constructing eagerly turns a
 *     missing env var into a build failure.
 *   - Its tables are created lazily because Onyx has no migration step. The
 *     adapter is the one consumer that reaches the database before any of our
 *     own code runs, so there is no natural call site to hang an ensure* guard
 *     on. After the first call ensureAuthTables() returns a settled promise,
 *     so the steady-state cost is a microtask.
 *
 * A Proxy is safe here where it was not around the Drizzle handle: Auth.js
 * only ever calls methods on the adapter, whereas DrizzleAdapter inspects its
 * client to pick a SQL dialect.
 */
function selfCreatingAdapter() {
  let real = null;
  const resolve = () => (real ||= DrizzleAdapter(getDb()));
  return new Proxy({}, {
    get(_target, prop) {
      return async (...args) => {
        await ensureAuthTables();
        const target = resolve();
        const value = target[prop];
        if (typeof value !== 'function') return value;
        return value.apply(target, args);
      };
    },
  });
}

// Okta is registered only when all three vars are present. The sign-in page
// checks NEXT_PUBLIC_OKTA_ENABLED separately, so the provider can be wired up
// and the button revealed independently.
const oktaConfigured =
  process.env.AUTH_OKTA_ID && process.env.AUTH_OKTA_SECRET && process.env.AUTH_OKTA_ISSUER;

// The full configuration: the Edge-safe base plus everything that needs Node.
// Used by route handlers and server components. Middleware uses authConfig
// alone — see auth.config.js.
export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  adapter: selfCreatingAdapter(),
  providers: [
    Resend({
      apiKey: process.env.RESEND_API_KEY,
      // Unused in practice — sendVerificationRequest below does the send — but
      // kept in sync with it so the two can never disagree about the sender.
      from: process.env.NOTIFY_FROM || 'Onyx <onboarding@resend.dev>',
      async sendVerificationRequest({ identifier: email, url }) {
        const client = new ResendClient(process.env.RESEND_API_KEY);
        const brand = await loadBrand();

        // Derive the origin from the magic link itself, so this works on
        // preview deploys and localhost without any extra configuration.
        let origin = brand.origin;
        let host = '';
        try {
          const u = new URL(url);
          origin = u.origin;
          host = u.host;
        } catch {
          /* keep the brand origin */
        }

        // Swap the raw /api/auth/callback/email?token=…&email=… link for a
        // short /verify/<id> URL. Google Safe Browsing repeatedly flags the
        // raw callback shape as phishing — an opaque token and an email
        // address in the query string of a first-hop-from-email link. The
        // /verify page is an ordinary page URL with nothing to flag, and the
        // hop to the real callback is a same-origin navigation from a page the
        // browser already trusts.
        //
        // If minting the redirect fails, fall back to the raw URL: a link that
        // might get flagged beats no way to sign in.
        let linkUrl = url;
        try {
          const { id } = await createMagicLinkRedirect({ targetUrl: url, email });
          linkUrl = `${origin}/verify/${id}`;
        } catch (e) {
          console.warn('[auth] magic-link redirect mint failed, using raw URL:', e.message);
        }

        const from = process.env.NOTIFY_FROM || `${brand.name} <onboarding@resend.dev>`;
        const { html, text, subject } = signInEmail({ brand, linkUrl, email, host, origin });

        const { error } = await client.emails.send({
          from,
          to: email,
          subject,
          html,
          // A plain-text alternative is not optional. Gmail and Outlook treat
          // HTML-only authentication mail as phishing-shaped; shipping both
          // parts of the multipart/alternative body is most of what keeps
          // these out of spam.
          text,
          // Transactional headers. List-Unsubscribe is expected by RFC 8058
          // even on auth mail, and Auto-Submitted stops vacation responders
          // from replying to a sign-in link.
          headers: {
            'List-Unsubscribe': `<mailto:unsubscribe@${(from.match(/@([^>]+)>?$/) || [])[1] || 'onyxfs.io'}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            'Auto-Submitted': 'auto-generated',
            'X-Entity-Type': 'transactional-auth',
          },
        });
        if (error) {
          // Resend's failures here are nearly always one of three setup
          // mistakes, and its raw message does not say which. Name them,
          // because this fires during first-run setup when the person has the
          // least context and the least patience.
          const detail = error.message || JSON.stringify(error);
          let hint = '';
          if (/domain is not verified|not verified/i.test(detail)) {
            hint = ` — the sending domain in NOTIFY_FROM ("${from}") is not verified in Resend.`
                 + ' Verify it, or use "Onyx <onboarding@resend.dev>" while testing.';
          } else if (/testing emails|own email address|can only send/i.test(detail)) {
            hint = ' — Resend\u2019s onboarding@resend.dev sender only delivers to the address'
                 + ' your Resend account is registered under. Verify a domain to reach anyone else.';
          } else if (/api key|unauthorized|invalid/i.test(detail)) {
            hint = ' — check RESEND_API_KEY.';
          }
          throw new Error(`Resend send failed: ${detail}${hint}`);
        }
      },
    }),
    ...(oktaConfigured
      ? [
          Okta({
            clientId: process.env.AUTH_OKTA_ID,
            clientSecret: process.env.AUTH_OKTA_SECRET,
            issuer: process.env.AUTH_OKTA_ISSUER,
          }),
        ]
      : []),
  ],
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ user, account }) {
      // The final gate: an env-admin, or an approved invite row.
      //
      // This is the one callback that cannot live in auth.config.js — it hits
      // the database, so it would break middleware's Edge bundle. That is
      // fine: middleware only checks that a valid session exists, and no
      // session is ever issued without passing through here first.
      //
      // The same check applies to Okta. Okta says WHO is signing in; the
      // allowlist decides WHETHER they may. Neither alone is sufficient, so a
      // compromised Okta tenant cannot mint access to an unapproved address
      // and a leaked allowlist cannot bypass the identity check.
      const provider = account?.provider || 'unknown';
      const ok = await isEmailGrantedAccess(user.email);
      if (!ok) {
        console.warn(`[auth] sign-in denied for ${user.email} via ${provider} — not approved`);
        return false;
      }
      return true;
    },
  },
});
