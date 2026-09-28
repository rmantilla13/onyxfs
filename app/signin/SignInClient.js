'use client';

import { useState } from 'react';
// useFormState (react-dom), not useActionState (react) — this is React 18.
import { useFormState, useFormStatus } from 'react-dom';
import { requestMagicLink, signInWithPassword } from './actions';
import BrandLogo from '@/app/components/BrandLogo';

/**
 * Sign in, and nothing else: there is no sign-up. Someone new is added by an
 * admin, which the line at the bottom says rather than offering a form.
 *
 * An emailed link is how everyone signs in. The password form behind the
 * quiet button is for the few accounts an admin gave a password — App
 * Review's, whose inbox nobody reads (lib/password-signin.js). The address
 * typed in one form carries over to the other.
 */
export default function SignInClient({ brandName, tagline, logo, oktaEnabled, linksPrinted, returnTo, error }) {
  const [linkState, sendLink] = useFormState(requestMagicLink, {});
  const [passwordState, submitPassword] = useFormState(signInWithPassword, {});
  const [usePassword, setUsePassword] = useState(false);
  const [email, setEmail] = useState('');

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card" style={{ width: '100%', maxWidth: 400, padding: 32 }}>
        <BrandLogo logo={logo} name={brandName} height={30} markSize={40} className="auth-logo" />
        <h1 style={{ fontSize: 22, marginBottom: 6 }}>{`Sign in to ${brandName}`}</h1>
        <p className="muted small" style={{ margin: '0 0 24px' }}>{tagline}</p>

        {error && (
          <p className="small" style={{ color: 'var(--danger)', marginBottom: 16 }}>{error}</p>
        )}

        {usePassword ? (
          <>
            <form action={submitPassword} className="stack">
              {returnTo && <input type="hidden" name="callbackUrl" value={returnTo} />}
              <input
                className="input" type="email" name="email" placeholder="you@example.com" required autoFocus={!email}
                autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)}
              />
              {/* The address came over from the link form: on to the password. */}
              <input
                className="input" type="password" name="password" placeholder="Password" required autoFocus={!!email}
                autoComplete="current-password"
              />
              <Submit idle="Sign in" busy="Signing in…" />
              {passwordState.error && <p className="small" style={{ color: 'var(--danger)' }}>{passwordState.error}</p>}
            </form>
            <p className="muted small" style={{ margin: '12px 0 0' }}>
              Only for an account an admin gave a password. Everyone else signs in with an emailed link.
            </p>
            <SwitchButton onClick={() => setUsePassword(false)}>Email me a sign-in link instead</SwitchButton>
          </>
        ) : linkState.sent ? (
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
          <>
            <form action={sendLink} className="stack">
              {returnTo && <input type="hidden" name="callbackUrl" value={returnTo} />}
              <input
                className="input" type="email" name="email" placeholder="you@example.com" required autoFocus
                autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)}
              />
              <Submit idle="Email me a sign-in link" busy="Sending…" />
              {linkState.error && <p className="small" style={{ color: 'var(--danger)' }}>{linkState.error}</p>}
            </form>
            <SwitchButton onClick={() => setUsePassword(true)}>Sign in with a password</SwitchButton>
          </>
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

/** Between the link and the password: a text button, second to the form above it. */
function SwitchButton({ onClick, children }) {
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={onClick} style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}>
      {children}
    </button>
  );
}
