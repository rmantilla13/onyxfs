'use client';

import { useState } from 'react';

export default function ShareClient({ brand, title, files = [], needsPassword, wrong }) {
  const [password, setPassword] = useState('');

  if (needsPassword) {
    return (
      <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <form
          className="card"
          style={{ width: '100%', maxWidth: 380, padding: 32 }}
          onSubmit={(e) => {
            e.preventDefault();
            const u = new URL(window.location.href);
            u.searchParams.set('p', password);
            window.location.href = u.toString();
          }}
        >
          <img src={brand.mark} alt="" width={40} height={40} style={{ borderRadius: 10, marginBottom: 24 }} />
          <h1 style={{ fontSize: 20, marginBottom: 8 }}>This link is protected</h1>
          <p className="muted small" style={{ marginBottom: 16 }}>Enter the password you were given.</p>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          {wrong && <p className="small" style={{ color: 'var(--danger)', marginTop: 8 }}>That password is not right.</p>}
          <button className="btn btn-primary" type="submit" style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}>
            Open
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="shell" style={{ padding: '32px 24px 64px' }}>
      <div className="row" style={{ marginBottom: 24 }}>
        <img src={brand.mark} alt="" width={28} height={28} style={{ borderRadius: 7 }} />
        <h1 style={{ fontSize: 20 }}>{title}</h1>
        <span className="muted small">{files.length} file{files.length === 1 ? '' : 's'}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 16 }}>
        {files.filter(Boolean).map((f) => (
          <a key={f.id} className="card" href={f.url} download={f.name} style={{ overflow: 'hidden' }}>
            <div style={{ aspectRatio: '4/3', background: 'color-mix(in srgb, var(--ink) 4%, transparent)', display: 'grid', placeItems: 'center' }}>
              {f.kind === 'image' ? (
                <img src={f.thumbnailUrl || f.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
              ) : (
                <span className="muted small mono">{f.kind}</span>
              )}
            </div>
            <div className="small" style={{ padding: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
          </a>
        ))}
      </div>
    </main>
  );
}
