import Link from 'next/link';

/**
 * Every admin section's frame: an h1, one plain-language line about what the
 * section is for, the primary action on the right, then an optional toolbar,
 * then the body. `parent` ({ href, label }) puts a way back above the title
 * for a section inside another (Duplicates, inside Usage).
 *
 * No hooks, so server and client sections both use it.
 */
export default function AdminPage({ title, description, actions, toolbar, parent, children, titleId }) {
  return (
    <div className="admin-page">
      <header className="admin-head">
        <div className="admin-head-text">
          {parent && (
            <Link href={parent.href} className="admin-parent">
              <span aria-hidden>‹</span> {parent.label}
            </Link>
          )}
          <h1 className="admin-title" id={titleId}>{title}</h1>
          {description && <p className="admin-desc muted">{description}</p>}
        </div>
        {actions && <div className="admin-actions">{actions}</div>}
      </header>
      {toolbar && <div className="admin-toolbar">{toolbar}</div>}
      {children}
    </div>
  );
}

/** A card with a heading, for the sections of a page. */
export function AdminCard({ title, id, hint, actions, children, className = '', tone }) {
  const headingId = id ? `${id}-h` : undefined;
  return (
    <section className={`card admin-card${tone ? ` is-${tone}` : ''}${className ? ` ${className}` : ''}`} id={id} aria-labelledby={headingId}>
      {(title || actions) && (
        <div className="admin-card-head">
          {title && <h2 className="admin-h2" id={headingId}>{title}</h2>}
          {actions && <div className="admin-card-actions">{actions}</div>}
        </div>
      )}
      {hint && <p className="admin-hint muted small">{hint}</p>}
      {children}
    </section>
  );
}
