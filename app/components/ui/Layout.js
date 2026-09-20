'use client';

/**
 * The small layout pieces that were local to AdminClient or hand-repeated
 * across pages. Promoted unchanged in behaviour so the admin panel keeps
 * rendering exactly as it does today — this is a move, not a redesign.
 */

/** A titled section with an optional explanatory line. */
export function Panel({ title, hint, children, actions }) {
  return (
    <section className="card" style={{ padding: 'var(--s5)', marginBottom: 'var(--s4)' }}>
      {(title || actions) && (
        <div className="row" style={{ marginBottom: hint ? 'var(--s1)' : 14 }}>
          {title && <h2 style={{ fontSize: 'var(--t-lg)' }}>{title}</h2>}
          {actions && <><div className="spacer" />{actions}</>}
        </div>
      )}
      {hint && <p className="muted small" style={{ margin: '0 0 14px' }}>{hint}</p>}
      {children}
    </section>
  );
}

/** A labelled form control with an optional hint beneath it. */
export function Field({ label, hint, children }) {
  return (
    <label style={{ display: 'block', marginBottom: 'var(--s3)' }}>
      <div className="small" style={{ marginBottom: 'var(--s1)', fontWeight: 500 }}>{label}</div>
      {children}
      {hint && <div className="muted small" style={{ marginTop: 'var(--s1)' }}>{hint}</div>}
    </label>
  );
}

/**
 * The centred single-card page used by sign-in, check-email, verify, the two
 * desktop hand-off screens and the share error state — six hand-written
 * copies of the same two style objects before this existed.
 *
 * Not a client component in spirit (it renders no state), but it lives here
 * with the rest of the layer; server components can import it freely.
 */
export function AuthCard({ mark, children, width }) {
  return (
    <main className="auth-page">
      <div className="card auth-card" style={width ? { maxWidth: width } : undefined}>
        {mark && <img src={mark} alt="" width={40} height={40} style={{ borderRadius: 10, marginBottom: 'var(--s5)' }} />}
        {children}
      </div>
    </main>
  );
}
