'use client';

import { useState } from 'react';

export default function PairClient({ brandName, markPath }) {
  const [code, setCode] = useState(null);
  const [expires, setExpires] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const mint = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/desktop/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'pairing', label: 'Pairing code' }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || 'Could not create a code');
      setCode(body.code);
      setExpires(body.expiresAt);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card" style={{ width: '100%', maxWidth: 420, padding: 32 }}>
        <img src={markPath} alt="" width={40} height={40} style={{ borderRadius: 10, marginBottom: 24 }} />
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>Pair {brandName}</h1>
        <p className="muted small" style={{ marginBottom: 20 }}>
          Type this code into the desktop app. It works once and expires in five minutes.
        </p>

        {code ? (
          <>
            <div
              className="mono"
              style={{ fontSize: 30, letterSpacing: '0.18em', textAlign: 'center', padding: '18px 0', border: '1px solid var(--line)', borderRadius: 'var(--radius)' }}
            >
              {code}
            </div>
            {expires && (
              <p className="muted small" style={{ textAlign: 'center', marginTop: 10 }}>
                Expires {new Date(Number(expires)).toLocaleTimeString()}
              </p>
            )}
          </>
        ) : (
          <button className="btn btn-primary" onClick={mint} disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
            {busy ? 'Generating…' : 'Generate a pairing code'}
          </button>
        )}
        {error && <p className="small" style={{ color: 'var(--danger)', marginTop: 12 }}>{error}</p>}
      </div>
    </main>
  );
}
