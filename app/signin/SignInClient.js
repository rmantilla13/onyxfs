'use client';

import { useState } from 'react';
// useFormState (react-dom), not useActionState (react) — this is React 18.
import { useFormState, useFormStatus } from 'react-dom';
import { requestMagicLink, requestAccess } from './actions';

export default function SignInClient({ brandName, tagline, markPath, oktaEnabled, linksPrinted, error }) {
  const [mode, setMode] = useState('signin');
  const [linkState, sendLink] = useFormState(requestMagicLink, {});
  const [accessState, askAccess] = useFormState(requestAccess, {});

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card" style={{ width: '100%', maxWidth: 400, padding: 32 }}>
        <img src={markPath} alt="" width={40} height={40} style={{ borderRadius: 10, marginBottom: 24 }} />
        <h1 style={{ fontSize: 22, marginBottom: 6 }}>
          {mode === 'signin' ? `Sign in to ${brandName}` : 'Request access'}
        </h1>
        <p className="muted small" style={{ margin: '0 0 24px' }}>
          {mode === 'signin' ? tagline : `Ask an admin to add you to ${brandName}.`}
        </p>

        {error && (
          <p className="small" style={{ color: 'var(--danger)', marginBottom: 16 }}>{error}</p>
        )}

        {mode === 'signin' ? (
          linkState.sent ? (
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
              <input className="input" type="email" name="email" placeholder="you@example.com" required autoFocus autoComplete="email" />
              <Submit idle="Email me a sign-in link" busy="Sending…" />
              {linkState.error && <p className="small" style={{ color: 'var(--danger)' }}>{linkState.error}</p>}
            </form>
          )
        ) : accessState.requested ? (
          <p className="small">Request submitted. You will get an email if it is approved.</p>
        ) : (
          <form action={askAccess} className="stack">
            <input className="input" type="email" name="email" placeholder="you@example.com" required autoFocus autoComplete="email" />
            <input className="input" type="text" name="name" placeholder="Your name" autoComplete="name" />
            <textarea className="input" name="reason" rows={3} placeholder="What do you need access to?" />
            <Submit idle="Request access" busy="Sending…" />
            {accessState.error && <p className="small" style={{ color: 'var(--danger)' }}>{accessState.error}</p>}
          </form>
        )}

        {oktaEnabled && mode === 'signin' && (
          <form action="/api/auth/signin/okta" method="post" style={{ marginTop: 12 }}>
            <button className="btn" type="submit" style={{ width: '100%', justifyContent: 'center' }}>
              Continue with Okta
            </button>
          </form>
        )}

        <button
          onClick={() => setMode(mode === 'signin' ? 'request' : 'signin')}
          className="small muted"
          style={{ background: 'none', border: 'none', padding: 0, marginTop: 24, cursor: 'pointer', textDecoration: 'underline' }}
        >
          {mode === 'signin' ? "Don't have access yet?" : 'Back to sign in'}
        </button>
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
