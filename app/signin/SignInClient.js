'use client';

// useFormState (react-dom), not useActionState (react) — this is React 18.
import { useFormState, useFormStatus } from 'react-dom';
import { requestMagicLink } from './actions';
import BrandLogo from '@/app/components/BrandLogo';

/**
 * Sign in, and nothing else: there is no sign-up. Someone new is added by an
 * admin, which the line at the bottom says rather than offering a form.
 */
export default function SignInClient({ brandName, tagline, logo, oktaEnabled, linksPrinted, returnTo, error }) {
  const [linkState, sendLink] = useFormState(requestMagicLink, {});

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card" style={{ width: '100%', maxWidth: 400, padding: 32 }}>
        <BrandLogo logo={logo} name={brandName} height={30} markSize={40} className="auth-logo" />
        <h1 style={{ fontSize: 22, marginBottom: 6 }}>{`Sign in to ${brandName}`}</h1>
        <p className="muted small" style={{ margin: '0 0 24px' }}>{tagline}</p>

        {error && (
          <p className="small" style={{ color: 'var(--danger)', marginBottom: 16 }}>{error}</p>
        )}

        {linkState.sent ? (
          <>
            <p className="small">
              If that address is approved, a sign-in link is on its way. It expires in 24 hours.
            </p>
            {linksPrinted && (
              <p className="muted small" style={{ margin: '12px 0 0' }}>
                Local development: nothing is emailed. The link is printed in the terminal running the dev server.
              </p>
            )}
          </>
        ) : (
          <form action={sendLink} className="stack">
            {returnTo && <input type="hidden" name="callbackUrl" value={returnTo} />}
            <input className="input" type="email" name="email" placeholder="you@example.com" required autoFocus autoComplete="email" />
            <Submit idle="Email me a sign-in link" busy="Sending…" />
            {linkState.error && <p className="small" style={{ color: 'var(--danger)' }}>{linkState.error}</p>}
          </form>
        )}

        {oktaEnabled && (
          <form action="/api/auth/signin/okta" method="post" style={{ marginTop: 12 }}>
            <button className="btn" type="submit" style={{ width: '100%', justifyContent: 'center' }}>
              Continue with Okta
            </button>
          </form>
        )}

        <p className="small muted" style={{ margin: '24px 0 0' }}>
          {`Don't have access yet? Ask an admin of ${brandName} to add you.`}
        </p>
      </div>
    </main>
  );
}

/**
 * useFormStatus only reports the status of a form it is rendered INSIDE, so the
 * submit button has to be its own component rather than inline in the form.
 */
function Submit({ idle, busy }) {
  const { pending } = useFormStatus();
  return (
    <button className="btn btn-primary" type="submit" disabled={pending} style={{ justifyContent: 'center' }}>
      {pending ? busy : idle}
    </button>
  );
}
