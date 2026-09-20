import NextAuth from 'next-auth';
import Resend from 'next-auth/providers/resend';
import Okta from 'next-auth/providers/okta';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { Resend as ResendClient } from 'resend';
import { db, ensureAuthTables, createMagicLinkRedirect } from '@/lib/db';
import { isEmailGrantedAccess } from '@/lib/auth-allowlist';
import { loadBrand } from '@/lib/brand-config';
import { signInEmail } from '@/lib/signin-email';

/**
 * Wrap every adapter method so the Auth.js tables are created on first use.
 * Onyx creates all its own tables lazily; the adapter is the one consumer that
 * reaches the database before any of our code runs, so this is where its
 * schema gets the same treatment. After the first call ensureAuthTables()
 * returns a settled promise, so the overhead is a microtask.
 */
function selfCreatingAdapter(base) {
  return new Proxy(base, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      return async (...args) => {
        await ensureAuthTables();
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

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: selfCreatingAdapter(DrizzleAdapter(db)),
  session: { strategy: 'jwt' },
  trustHost: true,
  pages: {
    signIn: '/signin',
    verifyRequest: '/signin/check-email',
    // Route Auth.js errors (Configuration, Verification, AccessDenied…) back to
    // /signin?error=<code> rather than the unstyled default page. The sign-in
    // screen turns the code into something a person can act on.
    error: '/signin',
  },
  providers: [
    Resend({
      apiKey: process.env.RESEND_API_KEY,
      from: process.env.NOTIFY_FROM,
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
        if (error) throw new Error(`Resend send failed: ${error.message || JSON.stringify(error)}`);
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
    async signIn({ user, account }) {
      // The final gate: an env-admin, or an approved invite row.
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
    async redirect({ url, baseUrl }) {
      // Land on the library after sign-in, unless a same-origin callback was
      // supplied (someone deep-linked to a file before signing in).
      try {
        if (url.startsWith('/')) return `${baseUrl}${url}`;
        if (new URL(url).origin === baseUrl) return url;
      } catch {
        /* malformed — fall through */
      }
      return baseUrl;
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.email = user.email;
        token.name = user.name;
      }
      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id;
        session.user.email = token.email;
        session.user.name = token.name;
      }
      return session;
    },
    authorized({ auth }) {
      return !!auth?.user;
    },
  },
});
