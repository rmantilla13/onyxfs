'use client';

import { useEffect } from 'react';

/**
 * Navigate to the Auth.js callback from the browser. See page.js for why this
 * is not a server redirect. The button is the no-script fallback and also
 * what the person sees for the moment before navigation lands.
 */
export default function VerifyHop({ targetUrl, brandName }) {
  useEffect(() => {
    const t = setTimeout(() => window.location.replace(targetUrl), 150);
    return () => clearTimeout(t);
  }, [targetUrl]);

  return (
    <>
      <h1 style={{ fontSize: 22, marginBottom: 8 }}>Signing you in…</h1>
      <p className="muted small" style={{ marginBottom: 20 }}>
        If nothing happens, continue below.
      </p>
      <a className="btn btn-primary" href={targetUrl} style={{ justifyContent: 'center' }}>
        Continue to {brandName}
      </a>
    </>
  );
}
