'use client';

import { useState } from 'react';
import BrandLogo from '@/app/components/BrandLogo';

export default function AuthorizeClient({ brandName, logo, email, challenge, state }) {
  const [status, setStatus] = useState(challenge ? 'ready' : 'missing');
  const [error, setError] = useState(null);

  const approve = async () => {
    setStatus('working');
    setError(null);
    try {
      const r = await fetch('/api/desktop/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'pkce', code_challenge: challenge, state, label: 'Desktop' }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || 'Authorization failed');
      // Hand the single-use code back through the custom scheme. The app is
      // already listening for it; the code is useless without the verifier it
      // kept to itself.
      window.location.href = body.redirect;
      setStatus('done');
    } catch (e) {
      setError(e.message);
      setStatus('ready');
    }
  };

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card" style={{ width: '100%', maxWidth: 420, padding: 32 }}>
        <BrandLogo logo={logo} name={brandName} height={30} markSize={40} className="auth-logo" />

        {status === 'missing' ? (
          <>
            <h1 style={{ fontSize: 22, marginBottom: 8 }}>Nothing to authorize</h1>
            <p className="muted small" style={{ margin: 0 }}>
              Open this page from the {brandName} desktop app — it needs to supply its own challenge.
              You can also use a <a href="/space/pair" style={{ textDecoration: 'underline' }}>pairing code</a>.
            </p>
          </>
        ) : status === 'done' ? (
          <>
            <h1 style={{ fontSize: 22, marginBottom: 8 }}>Connected</h1>
            <p className="muted small" style={{ margin: 0 }}>You can close this tab and return to {brandName}.</p>
          </>
        ) : (
          <>
            <h1 style={{ fontSize: 22, marginBottom: 8 }}>Connect {brandName}</h1>
            <p className="muted small" style={{ marginBottom: 20 }}>
              This will let the desktop app on this computer access the filespaces granted to <strong>{email}</strong>.
              It can be revoked at any time.
            </p>
            <button className="btn btn-primary" onClick={approve} disabled={status === 'working'} style={{ width: '100%', justifyContent: 'center' }}>
              {status === 'working' ? 'Connecting…' : 'Authorize this computer'}
            </button>
            {error && <p className="small" style={{ color: 'var(--danger)', marginTop: 12 }}>{error}</p>}
          </>
        )}
      </div>
    </main>
  );
}
