'use client';

import { useEffect, useRef } from 'react';
import Dialog from '@/app/components/ui/Dialog';

/**
 * A side sheet over a list: the drive (and, next, the person) editor.
 *
 * It is ui/Dialog with the .dialog-sheet class (admin.css), so it is a
 * native modal <dialog>: focus moves into it and back out, Escape closes it,
 * and the list behind is inert but keeps its scroll, sort and filters. On a
 * phone it rises from the bottom instead of sliding in from the side.
 *
 * It is opened by a route (/admin/drives/<id>), which is what makes it
 * deep-linkable: the page renders it open, and closing it is navigating
 * back to the list (`onClose`). A #hash in the address — #settings — is
 * scrolled to once it is open, since the browser's own jump to an anchor
 * happens before the dialog exists.
 *
 *   sections: [{ id, label }] — a strip of in-page links under the title.
 */
export default function Drawer({ title, subtitle, sections = [], onClose, footer, children, dismissable = true }) {
  const body = useRef(null);

  useEffect(() => {
    const hash = typeof window !== 'undefined' ? decodeURIComponent(window.location.hash.slice(1)) : '';
    if (!hash) return;
    // After Dialog's own effect has called showModal (a child's effects run
    // before its parent's), on the next frame so layout has happened.
    const t = requestAnimationFrame(() => {
      const el = body.current?.querySelector(`#${CSS.escape(hash)}`);
      if (!el) return;
      el.scrollIntoView({ block: 'start' });
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      el.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(t);
  }, []);

  return (
    <Dialog open onClose={onClose} title={title} className="dialog-sheet" footer={footer} dismissable={dismissable}>
      <div ref={body}>
        {subtitle && <div className="drawer-sub muted small">{subtitle}</div>}
        {sections.length > 1 && (
          <nav className="drawer-nav" aria-label="Sections">
            {sections.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                onClick={(e) => {
                  // In a <dialog> the page does not scroll, the body does:
                  // move it there by hand and keep the hash for a reload.
                  e.preventDefault();
                  const el = body.current?.querySelector(`#${CSS.escape(s.id)}`);
                  if (!el) return;
                  el.scrollIntoView({ block: 'start', behavior: 'smooth' });
                  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
                  el.focus({ preventScroll: true });
                  window.history.replaceState(window.history.state, '', `#${s.id}`);
                }}
              >
                {s.label}
              </a>
            ))}
          </nav>
        )}
        {children}
      </div>
    </Dialog>
  );
}

/** One titled part of a drawer, the target of its section links. */
export function DrawerSection({ id, title, tone, children }) {
  const headingId = `${id}-h`;
  return (
    <section id={id} className={`drawer-section${tone ? ` is-${tone}` : ''}`} aria-labelledby={headingId}>
      <h3 id={headingId}>{title}</h3>
      {children}
    </section>
  );
}
