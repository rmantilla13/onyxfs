'use client';

/**
 * The three states every section has besides "here it is":
 *
 *   loading  skeleton rows in --surface-sunken, `rows` of them
 *   empty    a sentence (`title`, optional `message`) and one primary action
 *   error    a card with the server's message and Retry (and `action`, a
 *            next step beside it). `error.body` is the response body as the
 *            server sent it: its `error` is the message, and anything else
 *            it carried is one click away, so a 503 that explains itself is
 *            never reduced to "failed". The status is added only when the
 *            message does not already say it.
 */
export default function AdminState({ kind, rows = 6, title, message, action, error, onRetry, retrying = false }) {
  if (kind === 'loading') {
    return (
      <div className="admin-skeleton" role="status" aria-live="polite">
        <span className="sr-only">Loading…</span>
        {Array.from({ length: rows }, (_, i) => <span key={i} className="skel skel-row" aria-hidden />)}
      </div>
    );
  }

  if (kind === 'empty') {
    return (
      <div className="card admin-empty">
        <p className="admin-empty-title">{title}</p>
        {message && <p className="muted small admin-empty-text">{message}</p>}
        {action && <div className="admin-empty-action">{action}</div>}
      </div>
    );
  }

  const body = error?.body;
  const extra = body && typeof body === 'object'
    ? Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'error'))
    : typeof body === 'string' && body.trim() && body.trim() !== error?.message ? body.trim() : null;
  const hasExtra = extra && (typeof extra === 'string' || Object.keys(extra).length > 0);
  const text = error?.message || 'Something went wrong on the server.';
  const status = error?.status && !text.includes(String(error.status)) ? error.status : null;
  return (
    <div className="card admin-error" role="alert">
      <p className="admin-error-title">{title || 'This could not be loaded.'}</p>
      <p className="small admin-error-text">
        {text}
        {status ? <span className="muted">{` (HTTP ${status})`}</span> : null}
      </p>
      {hasExtra && (
        <details className="admin-error-body">
          <summary className="small">What the server said</summary>
          <pre className="mono small">{typeof extra === 'string' ? extra : JSON.stringify(extra, null, 2)}</pre>
        </details>
      )}
      {(onRetry || action) && (
        <div className="admin-error-action">
          {onRetry && <button type="button" className="btn" onClick={onRetry} disabled={retrying}>{retrying ? 'Retrying…' : 'Retry'}</button>}
          {action}
        </div>
      )}
    </div>
  );
}
