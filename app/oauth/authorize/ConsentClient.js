'use client';

import { useState } from 'react';
import BrandLogo from '@/app/components/BrandLogo';

const READ_ABILITIES = [
  'Find, browse and read the files in the drives you choose below, and their metadata',
  'Nothing else: it cannot change, move, delete or share anything, and sees no other drive',
];

const ABILITIES = [
  'Find, browse and read your files, their tags, metadata and transcripts',
  'Make and change collections',
  'Tag files and folders, set metadata, rename and move — never delete',
  'Make share links, and read and add review comments',
];

/**
 * Allow or decline an MCP client. Allowing mints a single-use code for it
 * (POST /api/oauth/authorize) and sends the browser back to the client;
 * declining tells the client no. Either way it goes back only to an address
 * the client registered (checked by the page before this is drawn).
 *
 * `readOnly`: the client asked for read-only access, and the person picks the
 * drives it may read from `drives`. The server checks the picks again.
 */
export default function ConsentClient({ brandName, logo, email, problem, request, readOnly = false, drives = [] }) {
  const [status, setStatus] = useState('ready');
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState(() => (drives.length === 1 ? [drives[0].id] : []));
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const blocked = readOnly && !picked.length;

  const answer = async (allow) => {
    setStatus('working');
    setError(null);
    try {
      const r = await fetch('/api/oauth/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, allow, ...(readOnly ? { driveIds: picked } : {}) }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || 'Could not finish. Try again.');
      setStatus(allow ? 'done' : 'declined');
      window.location.href = body.redirect;
    } catch (e) {
      setError(e.message);
      setStatus('ready');
    }
  };

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card" style={{ width: '100%', maxWidth: 460, padding: 32 }}>
        <BrandLogo logo={logo} name={brandName} height={30} markSize={40} className="auth-logo" />
        {problem ? (
          <>
            <h1 style={{ fontSize: 22, marginBottom: 8 }}>This connection can’t be made</h1>
            <p className="muted small" style={{ margin: 0 }}>{problem}</p>
          </>
        ) : status === 'done' ? (
          <>
            <h1 style={{ fontSize: 22, marginBottom: 8 }}>Connected</h1>
            <p className="muted small" style={{ margin: 0 }}>Return to {request.clientName} to carry on. You can close this tab.</p>
          </>
        ) : readOnly ? (
          <>
            <h1 style={{ fontSize: 22, marginBottom: 8 }}>Let {request.clientName} read files in {brandName}?</h1>
            <p className="muted small" style={{ marginBottom: 12 }}>
              It will read as <strong>{email}</strong>, in only the drives you pick. It will be able to:
            </p>
            <ul className="small" style={{ margin: '0 0 16px', paddingLeft: 18, lineHeight: 1.6 }}>
              {READ_ABILITIES.map((a) => <li key={a}>{a}</li>)}
            </ul>
            {drives.length ? (
              <fieldset style={{ border: 0, padding: 0, margin: '0 0 16px' }}>
                <legend className="small" style={{ marginBottom: 6, fontWeight: 600 }}>Drives it may read</legend>
                {drives.map((d) => (
                  <label key={d.id} className="small" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                    <input type="checkbox" checked={picked.includes(d.id)} onChange={() => toggle(d.id)} />
                    {d.name}
                  </label>
                ))}
              </fieldset>
            ) : (
              <p className="small" style={{ marginBottom: 16 }}>You have no drives to share. Ask an admin to add you to one first.</p>
            )}
            <p className="muted small" style={{ marginBottom: 20 }}>
              It shows among your devices, where you can sign it out at any time.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={() => answer(false)} disabled={status === 'working'} style={{ flex: 1, justifyContent: 'center' }}>
                Decline
              </button>
              <button className="btn btn-primary" onClick={() => answer(true)} disabled={status === 'working' || blocked} style={{ flex: 1, justifyContent: 'center' }}>
                {status === 'working' ? 'Allowing…' : 'Allow read-only'}
              </button>
            </div>
            {error && <p className="small" style={{ color: 'var(--danger)', marginTop: 12 }}>{error}</p>}
          </>
        ) : (
          <>
            <h1 style={{ fontSize: 22, marginBottom: 8 }}>Allow {request.clientName} into {brandName}?</h1>
            <p className="muted small" style={{ marginBottom: 12 }}>
              It will act as <strong>{email}</strong>, with exactly what you can do in {brandName} — only the drives
              and files you can open, under the same rules as on the web. It will be able to:
            </p>
            <ul className="small" style={{ margin: '0 0 20px', paddingLeft: 18, lineHeight: 1.6 }}>
              {ABILITIES.map((a) => <li key={a}>{a}</li>)}
            </ul>
            <p className="muted small" style={{ marginBottom: 20 }}>
              It shows among your devices, where you can sign it out at any time.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={() => answer(false)} disabled={status === 'working'} style={{ flex: 1, justifyContent: 'center' }}>
                Decline
              </button>
              <button className="btn btn-primary" onClick={() => answer(true)} disabled={status === 'working'} style={{ flex: 1, justifyContent: 'center' }}>
                {status === 'working' ? 'Allowing…' : 'Allow'}
              </button>
            </div>
            {error && <p className="small" style={{ color: 'var(--danger)', marginTop: 12 }}>{error}</p>}
          </>
        )}
      </div>
    </main>
  );
}
