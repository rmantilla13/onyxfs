'use client';

import { useState } from 'react';
import FileCard from '@/app/components/ui/FileCard';

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

      {/* The same card the library grid uses. This was a second copy with a
          different tile size, and the copies had already drifted. */}
      <div className="files-grid">
        {files.filter(Boolean).map((f) => (
          <FileCard key={f.id} file={f} href={f.url} downloadName={f.name} />
        ))}
      </div>
    </main>
  );
}
