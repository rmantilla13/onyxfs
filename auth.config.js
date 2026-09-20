// auth.config.js — the Edge-safe half of the auth configuration.
//
// WHY THIS FILE EXISTS
//
// middleware.js runs on the Edge runtime, which has no TCP sockets. The
// database driver (postgres.js) needs them, so anything middleware imports
// must not reach lib/db.js — not even transitively. Importing the full auth.js
// there pulls the driver into the Edge bundle and fails at runtime on every
// request, which a build will not catch.
//
// So the config is split. This half holds everything middleware needs: the
// callbacks that read the JWT and decide whether a request is authorized. It
// imports nothing that touches the database.
//
// auth.js adds the adapter and the email provider on top of this and is used
// by API routes and server components, which run on Node.
//
// The session strategy is 'jwt', so middleware never needs the database to
// decide who someone is — the token carries it. The adapter exists only for
// Auth.js's own verification-token storage during the magic-link exchange,
// which happens in a route handler, not in middleware.

export const authConfig = {
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
  // Providers are added in auth.js. Middleware only reads tokens, so it needs
  // none — and the Resend provider would drag its SDK into the Edge bundle.
  providers: [],
  callbacks: {
    async redirect({ url, baseUrl }) {
      // Land on the library after sign-in, unless a same-origin callback was
      // supplied (someone deep-linked to a file before signing in).
      //
      // Never land on the sign-in or verify pages themselves: Auth.js defaults
      // the callback to the page sign-in was requested from, and delivering a
      // freshly signed-in person back to the form reads as "nothing happened".
      try {
        const target = new URL(url, baseUrl);
        if (target.origin !== baseUrl) return `${baseUrl}/files`;
        if (/^\/(signin|verify)(\/|$)/.test(target.pathname)) return `${baseUrl}/files`;
        return target.toString();
      } catch {
        /* malformed — fall through */
      }
      return `${baseUrl}/files`;
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
    // The gate middleware applies. Deliberately only a signed-in check:
    // anything finer — roles, feature flags, the invite allowlist — needs the
    // database and therefore belongs in a route handler or server component,
    // never here.
    authorized({ auth }) {
      return !!auth?.user;
    },
  },
};

export default authConfig;
