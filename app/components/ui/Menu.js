'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { menuKeyNav } from './ContextMenu';

/**
 * A dropdown menu for row and card actions.
 *
 * Deliberately small: a button, a list, close on escape, on outside click and
 * on choosing something. Opening focuses the first item and ↑ ↓ Home End move
 * between items (shared with the context menu); there is no type-ahead.
 */
export default function Menu({ label = 'Actions', trigger, children, align = 'right' }) {
  const [open, setOpen] = useState(false);
  // How far the popup has to move to stay inside the viewport. It is placed
  // relative to its trigger, so near an edge (a phone, a trigger at the far
  // right) it used to run off screen.
  const [shift, setShift] = useState({ x: 0, up: false });
  const wrap = useRef(null);
  const pop = useRef(null);
  const id = useId();

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e) => { if (!wrap.current?.contains(e.target)) close(); };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();          // do not also close a dialog we sit inside
      close();
      wrap.current?.querySelector('button')?.focus();
    };
    document.addEventListener('pointerdown', onDocDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDocDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, close]);

  useLayoutEffect(() => {
    if (!open) { setShift({ x: 0, up: false }); return; }
    const el = pop.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    let x = 0;
    if (r.right > window.innerWidth - margin) x = window.innerWidth - margin - r.right;
    if (r.left + x < margin) x = margin - r.left;
    const trigger = wrap.current.getBoundingClientRect();
    const up = r.bottom > window.innerHeight - margin && trigger.top - r.height - margin > 0;
    setShift({ x: Math.round(x), up });
  }, [open]);

  // Opening focuses the first item, so the arrow keys work straight away.
  useEffect(() => {
    if (open) pop.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [open]);

  const place = {
    ...(align === 'left' ? { right: 'auto', left: 0 } : null),
    ...(shift.x ? { transform: `translateX(${shift.x}px)` } : null),
    ...(shift.up ? { top: 'auto', bottom: 'calc(100% + var(--s1))' } : null),
  };

  return (
    <div className="menu-wrap" ref={wrap}>
      <button
        className="btn btn-ghost btn-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger || <><span aria-hidden>⋯</span><span className="sr-only">{label}</span></>}
      </button>
      {open && (
        // Clicks bubble to here rather than each item wiring its own close,
        // so an action can never leave the menu open by forgetting to.
        <div
          className="menu"
          id={id}
          role="menu"
          ref={pop}
          onClick={close}
          onKeyDown={(e) => menuKeyNav(e, pop.current)}
          style={Object.keys(place).length ? place : undefined}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ onClick, danger = false, disabled = false, children }) {
  return (
    <button
      className={`menu-item${danger ? ' danger' : ''}`}
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="menu-sep" role="separator" />;
}
