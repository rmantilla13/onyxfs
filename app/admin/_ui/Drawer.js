'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
 *   sections: [{ id, label }] — a strip of in-page links under the title;
 *   the one for the section in view is marked (aria-current), as it is
 *   scrolled to and after a #settings deep link.
 */
export default function Drawer({ title, subtitle, sections = [], onClose, footer, children, dismissable = true }) {
  const body = useRef(null);
  const [active, pin] = useSectionInView(body, sections);

  useEffect(() => {
    const hash = typeof window !== 'undefined' ? decodeURIComponent(window.location.hash.slice(1)) : '';
    const root = body.current;
    if (!hash || !root) return undefined;
    const target = () => root.querySelector(`#${CSS.escape(hash)}`);
    const go = () => {
      const el = target();
      if (el) el.scrollIntoView({ block: 'start' });
      return el;
    };
    // After Dialog's own effect has called showModal (a child's effects run
    // before its parent's), on the next frame so layout has happened.
    const frame = requestAnimationFrame(() => {
      const el = go();
      if (!el) return;
      pin(hash);
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      el.focus({ preventScroll: true });
    });
    // Sections above the target fill in as their own data arrives (the
    // member list, say) and would push it back down; keep it in place for a
    // moment, until the reader scrolls or types.
    let settled = false;
    const settle = () => { settled = true; };
    const ro = new ResizeObserver(() => { if (!settled) go(); });
    ro.observe(root);
    const scroller = root.closest('.dialog-body');
    scroller?.addEventListener('wheel', settle, { passive: true });
    scroller?.addEventListener('touchstart', settle, { passive: true });
    window.addEventListener('keydown', settle);
    const stop = setTimeout(settle, 2500);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(stop);
      ro.disconnect();
      scroller?.removeEventListener('wheel', settle);
      scroller?.removeEventListener('touchstart', settle);
      window.removeEventListener('keydown', settle);
    };
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
                aria-current={active === s.id ? 'location' : undefined}
                onClick={(e) => {
                  // In a <dialog> the page does not scroll, the body does:
                  // move it there by hand and keep the hash for a reload.
                  e.preventDefault();
                  const el = body.current?.querySelector(`#${CSS.escape(s.id)}`);
                  if (!el) return;
                  pin(s.id);
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

/**
 * Which of `sections` is in view in the drawer's scrolling body: the last
 * one whose top has passed under the sticky strip of links, or the last of
 * all once the body is scrolled to its end (a short final section never
 * reaches the top). A section picked by a link or the address (`pin`) is
 * the answer while it is on screen, until the reader scrolls themselves:
 * near the end of the drawer, going to "Usage" can only scroll so far,
 * and the strip should still say Usage.
 *
 * Returns [activeId, pin(id)].
 */
function useSectionInView(body, sections) {
  const [active, setActive] = useState(null);
  const pinned = useRef(null);
  const schedule = useRef(() => {});
  const ids = sections.map((s) => s.id).join(' ');
  const pin = useCallback((id) => { pinned.current = id; schedule.current(); }, []);
  useEffect(() => {
    const root = body.current;
    const scroller = root?.closest('.dialog-body');
    const list = ids ? ids.split(' ') : [];
    if (!root || !scroller || list.length < 2) return undefined;
    let frame = 0;
    const pick = () => {
      frame = 0;
      const nav = root.querySelector('.drawer-nav');
      const box = scroller.getBoundingClientRect();
      // Sections scroll to just under the strip (scroll-margin-top in
      // admin.css), so the line is a little below its bottom edge.
      const line = box.top + (nav?.offsetHeight || 0) + 24;
      const at = (id) => root.querySelector(`#${CSS.escape(id)}`);
      const held = pinned.current && list.includes(pinned.current) && at(pinned.current);
      if (held) {
        const r = held.getBoundingClientRect();
        if (r.top < box.bottom && r.bottom > line) { setActive(pinned.current); return; }
      }
      let id = list[0];
      for (const s of list) {
        const el = at(s);
        if (el && el.getBoundingClientRect().top <= line) id = s;
      }
      if (scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) id = list[list.length - 1];
      setActive(id);
    };
    const run = () => { if (!frame) frame = requestAnimationFrame(pick); };
    schedule.current = run;
    // The reader scrolling is the reader choosing: the pin lets go.
    const release = () => { pinned.current = null; };
    run();
    scroller.addEventListener('scroll', run, { passive: true });
    scroller.addEventListener('wheel', release, { passive: true });
    scroller.addEventListener('touchmove', release, { passive: true });
    scroller.addEventListener('keydown', release);
    const ro = new ResizeObserver(run);
    ro.observe(root);
    return () => {
      cancelAnimationFrame(frame);
      schedule.current = () => {};
      scroller.removeEventListener('scroll', run);
      scroller.removeEventListener('wheel', release);
      scroller.removeEventListener('touchmove', release);
      scroller.removeEventListener('keydown', release);
      ro.disconnect();
    };
  }, [body, ids]);
  return [active, pin];
}
